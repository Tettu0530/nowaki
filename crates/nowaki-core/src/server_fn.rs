//! Server functions (`"use server"`). An RSC-style server↔client boundary.
//!
//! A module with a top-level `"use server"` directive becomes a "server module", and its
//! exported functions become RPC endpoints that stay on the server. The client gets only
//! a tiny proxy instead of the implementation (async functions forwarding to `POST /__nowaki/fn`).
//! To keep server-only dependencies (DB drivers etc.) out of the client graph, both build
//! and dev treat server modules as a "zero-dependency boundary".
//!
//! The id is a stable hash of `<moduleKey>#<export>`. moduleKey is the root-relative posix path
//! without extension, so the client proxy and the server allowlist compute the same id independently.

use std::path::Path;

use anyhow::{anyhow, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::{Declaration, ModuleExportName, Statement};
use oxc::parser::Parser;
use oxc::span::SourceType;
use xxhash_rust::xxh3::xxh3_64;

/// RPC endpoint the client calls in a single request.
pub const SERVER_FN_PATH: &str = "/__nowaki/fn";

/// Whether this source is a server module (leading `"use server"` directive).
/// Doesn't parse; scans only the directive prologue (the leading run of string-literal statements).
pub fn has_use_server(source: &str) -> bool {
    has_directive(source, "use server")
}

/// Whether the leading directive prologue contains the `want` directive.
/// Skips whitespace, line/block comments, and preceding other directives ("use strict" etc.).
fn has_directive(source: &str, want: &str) -> bool {
    let bytes = source.as_bytes();
    let mut i = 0;
    if source.starts_with('\u{feff}') {
        i += 3; // UTF-8 BOM
    }
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        let quote = match bytes.get(i) {
            Some(&b'"') => b'"',
            Some(&b'\'') => b'\'',
            _ => return false, // non-directive statement → end of prologue
        };
        let start = i + 1;
        let mut j = start;
        while j < bytes.len() && bytes[j] != quote {
            if bytes[j] == b'\\' {
                j += 1;
            }
            j += 1;
        }
        if j >= bytes.len() {
            return false;
        }
        if &source[start..j] == want {
            return true;
        }
        // A different directive: skip the closing quote, optional `;`, and whitespace, then continue
        i = j + 1;
        while i < bytes.len() && (bytes[i] == b';' || bytes[i].is_ascii_whitespace()) {
            i += 1;
        }
    }
}

/// Root-relative posix path without extension (stable key for id computation).
pub fn module_key(root: &Path, abs: &Path) -> String {
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    rel.with_extension("").to_string_lossy().replace('\\', "/")
}

/// Root-relative posix path (with extension).
pub fn source_rel(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Stable server function id (64-bit hash of `<moduleKey>#<export>` as 16 hex digits).
pub fn server_fn_id(module_key: &str, export: &str) -> String {
    format!(
        "{:016x}",
        xxh3_64(format!("{module_key}#{export}").as_bytes())
    )
}

/// Collects the names a module exports (named declarations, `export {a}`, default).
/// Re-exports like `export * from` and `export {a} from` are excluded (they can't be proxied).
pub fn collect_exports(abs: &Path, source: &str) -> Result<Vec<String>> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(abs).unwrap_or_else(|_| SourceType::tsx());
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.errors.is_empty() {
        let msgs: Vec<String> = parsed.errors.iter().map(|e| e.to_string()).collect();
        return Err(anyhow!(
            "parse error in {}: {}",
            abs.display(),
            msgs.join("; ")
        ));
    }
    let mut out: Vec<String> = Vec::new();
    for stmt in &parsed.program.body {
        match stmt {
            Statement::ExportNamedDeclaration(d) => {
                if let Some(decl) = &d.declaration {
                    out.extend(decl_bound_names(decl));
                } else if d.source.is_none() {
                    for sp in &d.specifiers {
                        out.push(export_name_str(&sp.exported));
                    }
                }
            }
            Statement::ExportDefaultDeclaration(_) => out.push("default".to_string()),
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Generates the client proxy source for a server module (a dependency-free leaf).
/// Each export is an async function that does `fetch(SERVER_FN_PATH)`. The implementation never reaches the client.
pub fn client_proxy(module_key: &str, exports: &[String]) -> String {
    let mut out = String::new();
    out.push_str(
        "// nowaki: client proxy for a \"use server\" module (the implementation stays on the server).\n",
    );
    // Turn the FormData passed by `<form action={serverFn}>` into an object so it can be JSON-encoded.
    out.push_str(
        "const __nowakiArg = (a) => (typeof FormData !== \"undefined\" && a instanceof FormData) ? Object.fromEntries(a) : a;\n",
    );
    // The proxy itself. For `<form action={fn}>`, toString returns `__nowaki_action:<id>`
    // (preact stringifies a function action into the attribute, and the client form interceptor picks it up).
    out.push_str(&format!(
        "const __nowakiCall = (id) => {{\n  \
const fn = async (...args) => {{\n    \
const res = await fetch({path:?}, {{ method: \"POST\", headers: {{ \"content-type\": \"application/json\", \"x-nowaki-rpc\": \"1\" }}, body: JSON.stringify({{ id, args: args.map(__nowakiArg) }}) }});\n    \
let data = null;\n    \
try {{ data = await res.json(); }} catch {{}}\n    \
if (!res.ok) throw new Error((data && data.error) || (\"server function failed: \" + res.status));\n    \
return data ? data.result : null;\n  \
}};\n  \
fn.toString = () => \"__nowaki_action:\" + id;\n  \
fn.__nowakiId = id;\n  \
return fn;\n\
}};\n",
        path = SERVER_FN_PATH,
    ));
    for ex in exports {
        let id = server_fn_id(module_key, ex);
        if ex == "default" {
            out.push_str(&format!("export default __nowakiCall({id:?});\n"));
        } else {
            out.push_str(&format!("export const {ex} = __nowakiCall({id:?});\n"));
        }
    }
    out
}

/// One discovered server function.
pub struct DiscoveredFn {
    pub id: String,
    /// Root-relative posix path (with extension, for dev source imports)
    pub source_rel: String,
    /// moduleKey without extension
    pub module_key: String,
    pub export: String,
}

/// Scans the given directories (root-relative names) and collects every server function.
/// Both dev (imports sources directly) and build (functions.json) use the same result.
pub fn discover(core: &crate::NowakiCore, dirs: &[&str]) -> Vec<DiscoveredFn> {
    let mut out = Vec::new();
    for sub in dirs {
        let root = core.root.join(sub);
        if !root.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        walk(&root, &mut files);
        files.sort();
        for abs in files {
            if !crate::is_transformable(&abs) {
                continue;
            }
            let Ok(src) = core.read_source(&abs) else {
                continue;
            };
            if !has_use_server(&src) {
                continue;
            }
            let key = module_key(&core.root, &abs);
            let rel = source_rel(&core.root, &abs);
            let Ok(exports) = collect_exports(&abs, &src) else {
                continue;
            };
            for ex in exports {
                out.push(DiscoveredFn {
                    id: server_fn_id(&key, &ex),
                    source_rel: rel.clone(),
                    module_key: key.clone(),
                    export: ex,
                });
            }
        }
    }
    out
}

fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn export_name_str(n: &ModuleExportName) -> String {
    match n {
        ModuleExportName::IdentifierName(i) => i.name.to_string(),
        ModuleExportName::IdentifierReference(i) => i.name.to_string(),
        ModuleExportName::StringLiteral(s) => s.value.to_string(),
    }
}

fn decl_bound_names(decl: &Declaration) -> Vec<String> {
    match decl {
        Declaration::VariableDeclaration(v) => v
            .declarations
            .iter()
            .filter_map(|d| d.id.get_binding_identifier().map(|b| b.name.to_string()))
            .collect(),
        Declaration::FunctionDeclaration(f) => {
            f.id.as_ref()
                .map(|i| vec![i.name.to_string()])
                .unwrap_or_default()
        }
        Declaration::ClassDeclaration(c) => {
            c.id.as_ref()
                .map(|i| vec![i.name.to_string()])
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn detects_use_server_directive() {
        assert!(has_use_server("\"use server\";\nexport function a(){}"));
        assert!(has_use_server("'use server'\nexport const b = 1"));
        // skips leading comments and blank lines
        assert!(has_use_server("// top\n\n  \"use server\";\n"));
        assert!(has_use_server("/* c */ \"use server\";"));
        // found even after another directive
        assert!(has_use_server("\"use strict\";\n\"use server\";"));
        // strings mid-body are not false positives
        assert!(!has_use_server("export const x = \"use server\";"));
        assert!(!has_use_server("const a = 1;\n\"use server\";"));
        assert!(!has_use_server(
            "export function a(){ return \"use server\"; }"
        ));
    }

    #[test]
    fn module_key_strips_ext_and_normalizes() {
        let root = PathBuf::from("/app");
        assert_eq!(
            module_key(&root, &PathBuf::from("/app/actions/todos.ts")),
            "actions/todos"
        );
        assert_eq!(
            module_key(&root, &PathBuf::from("/app/lib/db.tsrx")),
            "lib/db"
        );
    }

    #[test]
    fn id_is_stable_and_distinct() {
        let a = server_fn_id("actions/todos", "addTodo");
        let a2 = server_fn_id("actions/todos", "addTodo");
        assert_eq!(a, a2, "same input, same id");
        assert_ne!(a, server_fn_id("actions/todos", "listTodos"));
        assert_ne!(a, server_fn_id("actions/other", "addTodo"));
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn collect_exports_finds_all_forms() {
        let src = "\"use server\";\n\
export async function addTodo(t){}\n\
export const listTodos = async () => [];\n\
function helper(){}\n\
export { helper };\n\
export default async function(){}\n";
        let names = collect_exports(Path::new("/app/actions/todos.ts"), src).unwrap();
        assert!(names.contains(&"addTodo".to_string()));
        assert!(names.contains(&"listTodos".to_string()));
        assert!(names.contains(&"helper".to_string()));
        assert!(names.contains(&"default".to_string()));
    }

    #[test]
    fn client_proxy_has_no_impl_and_one_entry_per_export() {
        let proxy = client_proxy(
            "actions/todos",
            &["addTodo".to_string(), "default".to_string()],
        );
        assert!(proxy.contains("export const addTodo = __nowakiCall("));
        assert!(proxy.contains("export default __nowakiCall("));
        assert!(proxy.contains(SERVER_FN_PATH));
        // no trace of the implementation
        assert!(!proxy.contains("function addTodo"));
    }
}
