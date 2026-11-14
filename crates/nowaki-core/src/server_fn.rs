//! Server functions (`"use server"`). An RSC-style server↔client boundary.
//!
//! A module with a top-level `"use server"` directive becomes a "server module", and its
//! exported functions become RPC endpoints that stay on the server. The client gets only a tiny
//! proxy instead of the implementation (async functions forwarding to `POST /__nowaki/fn`, under
//! basePath when one is set). To keep server-only dependencies (DB drivers etc.) out of the
//! client graph, both build and dev treat server modules as a "zero-dependency boundary".
//!
//! The id is a stable hash of `<moduleKey>#<export>`. moduleKey is the root-relative POSIX path
//! without extension, so the client proxy and the server allowlist compute the same id
//! independently.

use std::path::Path;

use anyhow::Result;
use oxc::allocator::Allocator;
use oxc::ast::ast::{Declaration, Expression, ModuleExportName, Statement};
use xxhash_rust::xxh3::xxh3_64;

/// The RPC endpoint the client proxies post to, at the root (see [`client_proxy_at`] for
/// basePath).
pub const SERVER_FN_PATH: &str = "/__nowaki/fn";

/// Whether this source is a server module (leading `"use server"` directive). Doesn't parse;
/// scans only the directive prologue (the leading run of string-literal statements).
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
        // A different directive: skip the closing quote, optional `;`, and whitespace, then
        // continue.
        i = j + 1;
        while i < bytes.len() && (bytes[i] == b';' || bytes[i].is_ascii_whitespace()) {
            i += 1;
        }
    }
}

/// Root-relative POSIX path without extension (the stable key for id computation).
pub fn module_key(root: &Path, abs: &Path) -> String {
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    rel.with_extension("").to_string_lossy().replace('\\', "/")
}

/// Root-relative POSIX path (with extension).
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

/// Collects the names a module exports (named declarations, `export {a}`, default), sorted.
/// Re-exports like `export * from` and `export {a} from` are excluded (they can't be proxied), and
/// so are destructured declarations (`export const { a } = o`).
pub fn collect_exports(abs: &Path, source: &str) -> Result<Vec<String>> {
    let allocator = Allocator::default();
    let program = crate::transform::parse_program(
        &allocator,
        abs,
        source,
        crate::transform::source_type_for_path(abs),
    )?;
    let mut out: Vec<String> = Vec::new();
    for stmt in &program.body {
        match stmt {
            Statement::ExportDeclaration(d) => out.extend(decl_bound_names(&d.declaration)),
            Statement::ExportNamedDeclaration(d) => {
                for sp in &d.specifiers {
                    out.push(export_name_str(&sp.exported));
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

/// Exports that take arguments without validating them: a function (declaration, arrow, or
/// expression, default export included) with at least one parameter, or a `const` initialized
/// with anything but `serverFn(schema, impl)`. `export { a }` lists are not inspected.
pub fn unvalidated_exports(abs: &Path, source: &str) -> Result<Vec<String>> {
    let allocator = Allocator::default();
    let program = crate::transform::parse_program(
        &allocator,
        abs,
        source,
        crate::transform::source_type_for_path(abs),
    )?;
    let mut out = Vec::new();
    for stmt in &program.body {
        match stmt {
            Statement::ExportDeclaration(d) => match &d.declaration {
                Declaration::FunctionDeclaration(f) if !f.params.is_empty() => {
                    if let Some(id) = &f.id {
                        out.push(id.name.to_string());
                    }
                }
                Declaration::VariableDeclaration(v) => {
                    for decl in &v.declarations {
                        let takes_input = match &decl.init {
                            Some(Expression::CallExpression(c)) => !matches!(
                                &c.callee,
                                Expression::Identifier(id) if id.name == "serverFn"
                            ),
                            Some(Expression::ArrowFunctionExpression(f)) => !f.params.is_empty(),
                            Some(Expression::FunctionExpression(f)) => !f.params.is_empty(),
                            _ => false,
                        };
                        if let (true, Some(b)) = (takes_input, decl.id.get_binding_identifier()) {
                            out.push(b.name.to_string());
                        }
                    }
                }
                _ => {}
            },
            Statement::ExportDefaultDeclaration(d) => {
                use oxc::ast::ast::ExportDefaultDeclarationKind as K;
                let takes_input = match &d.declaration {
                    K::FunctionDeclaration(f) => !f.params.is_empty(),
                    K::ArrowFunctionExpression(f) => !f.params.is_empty(),
                    K::FunctionExpression(f) => !f.params.is_empty(),
                    K::CallExpression(c) => !matches!(
                        &c.callee,
                        Expression::Identifier(id) if id.name == "serverFn"
                    ),
                    _ => false,
                };
                if takes_input {
                    out.push("default".to_string());
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Generates the client proxy source for a server module (a dependency-free leaf). Each export
/// is an async function that posts to [`SERVER_FN_PATH`]. The implementation never reaches the
/// client.
pub fn client_proxy(module_key: &str, exports: &[String]) -> String {
    client_proxy_at(module_key, exports, SERVER_FN_PATH)
}

/// The server function endpoint for the `import.meta.env.BASE_URL` in `defines`.
pub(crate) fn fn_path(defines: &[(String, String)]) -> String {
    format!("{}__nowaki/fn", crate::env::base_url(defines))
}

/// [`client_proxy`] posting to `path` instead of [`SERVER_FN_PATH`] (under nowaki.config
/// `basePath`: `<base>/__nowaki/fn`).
pub fn client_proxy_at(module_key: &str, exports: &[String], path: &str) -> String {
    let mut out = String::new();
    out.push_str(
        "// nowaki: client proxy for a \"use server\" module (the implementation stays on the server).\n",
    );
    // Turn the FormData passed by `<form action={serverFn}>` into an object so it can be
    // JSON-encoded.
    out.push_str(
        "const __nowakiArg = (a) => (typeof FormData !== \"undefined\" && a instanceof FormData) ? Object.fromEntries(a) : a;\n",
    );
    // The proxy itself. For `<form action={fn}>`, toString returns `__nowaki_action:<id>` (Preact
    // stringifies a function action into the attribute, and the client form interceptor picks
    // it up).
    out.push_str(&format!(
        "const __nowakiCall = (id) => {{\n  \
const fn = async (...args) => {{\n    \
const res = await fetch({path:?}, {{ method: \"POST\", headers: {{ \"content-type\": \"application/json\", \"x-nowaki-rpc\": \"1\" }}, body: JSON.stringify({{ id, args: args.map(__nowakiArg) }}) }});\n    \
let data = null;\n    \
try {{ data = await res.json(); }} catch {{}}\n    \
if (!res.ok) {{ const e = new Error((data && data.error) || (\"server function failed: \" + res.status)); e.status = res.status; if (data && data.data !== undefined) e.data = data.data; throw e; }}\n    \
return data ? data.result : null;\n  \
}};\n  \
fn.toString = () => \"__nowaki_action:\" + id;\n  \
fn.__nowakiId = id;\n  \
return fn;\n\
}};\n",
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
    /// [`server_fn_id`] of `module_key` and `export`.
    pub id: String,
    /// Root-relative POSIX path (with extension, for dev source imports).
    pub source_rel: String,
    /// [`module_key`]: the path without extension.
    pub module_key: String,
    /// The export name (`default` for the default export).
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

/// `<source_rel>#<export>` for each discovered server function that takes unvalidated input
/// (see [`unvalidated_exports`]). `nowaki build` warns about these.
pub fn discover_unvalidated(core: &crate::NowakiCore, dirs: &[&str]) -> Vec<String> {
    let mut by_file: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for f in discover(core, dirs) {
        by_file.entry(f.source_rel).or_default().push(f.export);
    }
    let mut out = Vec::new();
    for (rel, exports) in by_file {
        let abs = core.root.join(&rel);
        let Ok(src) = core.read_source(&abs) else {
            continue;
        };
        let unvalidated = unvalidated_exports(&abs, &src).unwrap_or_default();
        for ex in exports.into_iter().filter(|e| unvalidated.contains(e)) {
            out.push(format!("{rel}#{ex}"));
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
        // Export names must be well-formed Unicode (an early error otherwise), so `display` is
        // exact.
        ModuleExportName::StringLiteral(s) => s.value.display().to_string(),
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
    fn unvalidated_exports_take_input_without_server_fn() {
        let src = "\"use server\";\nimport { serverFn } from \"@nowaki-dev/runtime\";\n\
            export const a = serverFn(s, async (x) => x);\n\
            export const b = async (x) => x;\n\
            export const c = async () => 1;\n\
            export async function d(x) {}\n\
            export async function e() {}\n\
            export const f = wrap(async (x) => x);\n\
            export default async function (x) {}\n";
        let mut v = unvalidated_exports(&PathBuf::from("actions/x.ts"), src).unwrap();
        v.sort();
        assert_eq!(v, vec!["b", "d", "default", "f"]);
    }

    #[test]
    fn detects_use_server_directive() {
        assert!(has_use_server("\"use server\";\nexport function a(){}"));
        assert!(has_use_server("'use server'\nexport const b = 1"));
        // Skips leading comments and blank lines.
        assert!(has_use_server("// top\n\n  \"use server\";\n"));
        assert!(has_use_server("/* c */ \"use server\";"));
        // Found even after another directive.
        assert!(has_use_server("\"use strict\";\n\"use server\";"));
        // Strings mid-body are not false positives.
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
export { shared } from \"./shared.ts\";\n\
export default async function(){}\n";
        let names = collect_exports(Path::new("/app/actions/todos.ts"), src).unwrap();
        assert!(!names.contains(&"shared".to_string()));
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
        // No trace of the implementation.
        assert!(!proxy.contains("function addTodo"));
    }
}
