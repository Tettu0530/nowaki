//! Scope-hoisting chunk generation.
//!
//! The "app modules (under the project, not node_modules) reachable from an island and used
//! only by that island" are concatenated into one scope (= scope hoisting).
//! Top-level bindings are renamed to globally unique names; in-chunk imports become direct references,
//! and imports outside the chunk (node_modules / shared modules) stay as ESM imports.
//! node_modules are split into separate shared chunks, so there is only one preact instance.
//! The whole chunk is minified after concatenation.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::{
    Declaration, ExportDefaultDeclarationKind, ImportDeclarationSpecifier, ModuleExportName,
    Statement,
};
use oxc::codegen::{Codegen, CodegenOptions, CommentOptions, LegalComment};
use oxc::minifier::{Minifier, MinifierOptions};
use oxc::span::SourceType;
use xxhash_rust::xxh3::xxh3_64;

use crate::NowakiCore;

/// Whether this is an app-side module to transform (under the project, not node_modules).
pub fn is_app_module(core: &NowakiCore, abs: &Path) -> bool {
    crate::is_transformable(abs)
        && abs.starts_with(&core.root)
        && !abs.components().any(|c| c.as_os_str() == "node_modules")
}

/// Returns a module's direct deps (resolved absolute paths).
pub fn module_deps(core: &NowakiCore, abs: &Path) -> Result<Vec<PathBuf>> {
    Ok(extract_meta(core, abs, 0)?
        .deps
        .into_iter()
        .map(|(p, _)| p)
        .collect())
}

/// Collects app-side modules reachable from entry (including entry). Doesn't descend into node_modules.
pub fn collect_app_modules(core: &NowakiCore, entry: &Path) -> HashSet<PathBuf> {
    let mut set = HashSet::new();
    let mut stack = vec![entry.to_path_buf()];
    while let Some(abs) = stack.pop() {
        if !is_app_module(core, &abs) || !set.insert(abs.clone()) {
            continue;
        }
        if let Ok(deps) = module_deps(core, &abs) {
            for d in deps {
                if is_app_module(core, &d) {
                    stack.push(d);
                }
            }
        }
    }
    set
}

/// Whether this module contains syntax concatenation doesn't support (`export *` etc.).
pub fn needs_fallback(core: &NowakiCore, abs: &Path) -> bool {
    extract_meta(core, abs, 0)
        .map(|m| m.fallback)
        .unwrap_or(true)
}

/// A module's import / export metadata (no AST kept).
struct ModuleMeta {
    /// (resolved absolute path, original specifier)
    deps: Vec<(PathBuf, String)>,
    /// export name → local binding name (`export {a as b}` gives b→a)
    exports: Vec<(String, String)>,
    imports: Vec<ImportInfo>,
    /// import local name → (source abs, imported name; `"default"` for a default import), so an
    /// `export { x }` of an imported `x` (a barrel file) resolves to the binding it forwards
    import_bindings: HashMap<String, (PathBuf, String)>,
    /// Global index used for the rename suffix
    idx: usize,
    /// Contains unsupported syntax, so fall back to standalone emit
    fallback: bool,
}

struct ImportInfo {
    source_abs: PathBuf,
    items: Vec<ImportItem>,
}

#[derive(Clone)]
enum ImportItem {
    /// `import { imported as local }`
    Named { imported: String, local: String },
    /// `import local`（default import）
    Default { local: String },
    /// `import "x"` (side effects only)
    SideEffect,
}

/// Generates an island chunk's code. `internal` is the set of app modules concatenated into this chunk
/// (including entry). `external_name` maps "out-of-chunk module abs → its separately emitted file name".
/// Returns the chunk source (not minified). The entry's default export becomes the chunk's default.
#[allow(clippy::too_many_arguments)]
pub fn hoist_chunk(
    core: &NowakiCore,
    entry: &Path,
    internal: &[PathBuf],
    external_name: &HashMap<PathBuf, String>,
) -> Result<String> {
    let internal_set: HashSet<&Path> = internal.iter().map(|p| p.as_path()).collect();
    let mut metas: HashMap<PathBuf, ModuleMeta> = HashMap::new();
    for (i, abs) in internal.iter().enumerate() {
        let meta = extract_meta(core, abs, i)?;
        metas.insert(abs.clone(), meta);
    }

    // Concatenation order: deps first (post-order DFS). Cycles stop at visited nodes.
    let mut order: Vec<PathBuf> = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut stack: HashSet<PathBuf> = HashSet::new();
    order_modules(entry, &metas, &mut order, &mut visited, &mut stack);

    let renamed_export =
        |abs: &Path, export_name: &str| resolve_export(&metas, abs, export_name, 0);

    let mut ext_imports = ExternalImports::default();
    let mut bodies: Vec<String> = Vec::new();

    for abs in &order {
        let meta = &metas[abs];
        let mut wiring = ImportWiring::default();
        for imp in &meta.imports {
            let internal_dep = internal_set.contains(imp.source_abs.as_path());
            for item in &imp.items {
                match item {
                    ImportItem::Named { imported, local } => {
                        if internal_dep {
                            // An unresolved name would be left dangling (a ReferenceError at
                            // hydration), so give up and let the caller emit unbundled.
                            let target = renamed_export(&imp.source_abs, imported)
                                .ok_or_else(|| unresolved_import(abs, imported, &imp.source_abs))?;
                            wiring.rename_local.insert(local.clone(), target);
                        } else {
                            let renamed = format!("{local}${}", meta.idx);
                            wiring.rename_local.insert(local.clone(), renamed.clone());
                            if let Some(file) = external_name.get(&imp.source_abs) {
                                ext_imports
                                    .file(file)
                                    .add_named(format!("{imported} as {renamed}"));
                            }
                        }
                    }
                    ImportItem::Default { local } => {
                        if internal_dep {
                            let target =
                                renamed_export(&imp.source_abs, "default").ok_or_else(|| {
                                    unresolved_import(abs, "default", &imp.source_abs)
                                })?;
                            wiring.rename_local.insert(local.clone(), target);
                        } else {
                            let renamed = format!("{local}${}", meta.idx);
                            wiring.rename_local.insert(local.clone(), renamed.clone());
                            if let Some(file) = external_name.get(&imp.source_abs) {
                                ext_imports.file(file).add_default(renamed);
                            }
                        }
                    }
                    ImportItem::SideEffect => {
                        if !internal_dep {
                            if let Some(file) = external_name.get(&imp.source_abs) {
                                ext_imports.file(file);
                            }
                        }
                    }
                }
            }
        }
        let body = render_body(core, abs, meta.idx, &wiring)?;
        bodies.push(body);
    }

    let entry_default = renamed_export(entry, "default")
        .ok_or_else(|| anyhow!("island has no default export: {}", entry.display()))?;

    let mut out = ext_imports.render();
    for body in &bodies {
        out.push_str(body);
        out.push('\n');
    }
    out.push_str(&format!("export{{{entry_default} as default}};\n"));
    Ok(out)
}

/// The chunk-wide name of `export_name` of the internal module `abs`. An export that forwards an
/// import (`import { x } from "./a.ts"; export { x }`) resolves to the name render_body gives that
/// import: the source module's binding when it is in the chunk, or our own suffixed alias of the
/// external import. None when the module doesn't export the name.
fn resolve_export(
    metas: &HashMap<PathBuf, ModuleMeta>,
    abs: &Path,
    export_name: &str,
    depth: usize,
) -> Option<String> {
    // A forwarding cycle (`a` re-exports `b`'s `x`, which re-exports `a`'s) has no binding.
    if depth > metas.len() {
        return None;
    }
    let m = metas.get(abs)?;
    let (_, local) = m.exports.iter().find(|(n, _)| n == export_name)?;
    if let Some((source, imported)) = m.import_bindings.get(local) {
        if metas.contains_key(source) {
            return resolve_export(metas, source, imported, depth + 1);
        }
    }
    Some(format!("{local}${}", m.idx))
}

fn unresolved_import(importer: &Path, name: &str, source: &Path) -> anyhow::Error {
    anyhow!(
        "{}: `{name}` from {} does not resolve to a binding in the chunk",
        importer.display(),
        source.display()
    )
}

#[derive(Default)]
struct ImportWiring {
    /// Original local name → renamed name (internal: the dep's global name; external: our own suffixed name)
    rename_local: HashMap<String, String>,
}

/// The chunk's imports from other chunks, one statement per file (in first-use order), so
/// `import{a}from"x";import{b}from"x"` becomes `import{a,b}from"x"`.
#[derive(Default)]
struct ExternalImports {
    files: Vec<ExternalImport>,
}

struct ExternalImport {
    file: String,
    default: Option<String>,
    named: Vec<String>,
}

impl ExternalImports {
    fn file(&mut self, file: &str) -> &mut ExternalImport {
        let i = match self.files.iter().position(|f| f.file == file) {
            Some(i) => i,
            None => {
                self.files.push(ExternalImport {
                    file: file.to_string(),
                    default: None,
                    named: Vec::new(),
                });
                self.files.len() - 1
            }
        };
        &mut self.files[i]
    }

    fn render(&self) -> String {
        let mut out = String::new();
        for f in &self.files {
            let mut clause = Vec::new();
            if let Some(d) = &f.default {
                clause.push(d.clone());
            }
            if !f.named.is_empty() {
                clause.push(format!("{{{}}}", f.named.join(",")));
            }
            if clause.is_empty() {
                out.push_str(&format!("import\"./{}\";\n", f.file));
            } else {
                out.push_str(&format!(
                    "import {} from\"./{}\";\n",
                    clause.join(","),
                    f.file
                ));
            }
        }
        out
    }
}

impl ExternalImport {
    fn add_named(&mut self, spec: String) {
        if !self.named.contains(&spec) {
            self.named.push(spec);
        }
    }

    // Two modules can default-import the same file under different names; the second one
    // becomes a named `default as` import so both bindings stay.
    fn add_default(&mut self, local: String) {
        match &self.default {
            None => self.default = Some(local),
            Some(d) if *d == local => {}
            Some(_) => self.add_named(format!("default as {local}")),
        }
    }
}

/// Extracts only import/export metadata (used for concatenation order and wiring).
fn extract_meta(core: &NowakiCore, abs: &Path, idx: usize) -> Result<ModuleMeta> {
    let allocator = Allocator::default();
    let source = core.read_source(abs)?;
    // Server modules (`"use server"`) are a client concatenation boundary. Don't follow their deps (keeps
    // server-only deps off the client) and don't concatenate them (emit makes the proxy a separate chunk).
    if crate::server_fn::has_use_server(&source) {
        return Ok(ModuleMeta {
            deps: Vec::new(),
            exports: Vec::new(),
            imports: Vec::new(),
            import_bindings: HashMap::new(),
            idx,
            fallback: true,
        });
    }
    let source_type = crate::transform::source_type_for_path(abs);
    let mut program = crate::transform::parse_program(&allocator, abs, &source, source_type)?;
    let scoping = crate::transform::semantic_scoping(&program);
    crate::transform::run_preact_transform(&allocator, abs, &source, scoping, &mut program)?;

    let dir = abs.parent().unwrap_or(&core.root);
    let mut meta = ModuleMeta {
        deps: Vec::new(),
        exports: Vec::new(),
        imports: Vec::new(),
        import_bindings: HashMap::new(),
        idx,
        fallback: false,
    };

    for stmt in &program.body {
        match stmt {
            Statement::ImportDeclaration(d) => {
                let Some(spec) = d.source.value.as_str() else {
                    continue;
                };
                let Some(abs_src) = resolve(core, dir, spec) else {
                    continue;
                };
                meta.deps.push((abs_src.clone(), spec.to_string()));
                let mut items = Vec::new();
                if let Some(specs) = &d.specifiers {
                    for s in specs {
                        match s {
                            ImportDeclarationSpecifier::ImportSpecifier(sp) => {
                                let imported = export_name_str(&sp.imported);
                                let local = sp.local.name.to_string();
                                meta.import_bindings
                                    .insert(local.clone(), (abs_src.clone(), imported.clone()));
                                items.push(ImportItem::Named { imported, local });
                            }
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(sp) => {
                                let local = sp.local.name.to_string();
                                meta.import_bindings
                                    .insert(local.clone(), (abs_src.clone(), "default".into()));
                                items.push(ImportItem::Default { local });
                            }
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                                meta.fallback = true; // `import * as` unsupported
                            }
                        }
                    }
                } else {
                    items.push(ImportItem::SideEffect);
                }
                meta.imports.push(ImportInfo {
                    source_abs: abs_src,
                    items,
                });
            }
            Statement::ExportDeclaration(d) => {
                for name in decl_bound_names(&d.declaration) {
                    meta.exports.push((name.clone(), name));
                }
            }
            Statement::ExportFromDeclaration(d) => {
                // `export {..} from` re-export unsupported. Still a dependency: the graph
                // walks (sharing counts, budgets) must see it.
                meta.fallback = true;
                if let Some(spec) = d.source.value.as_str() {
                    if let Some(abs_src) = resolve(core, dir, spec) {
                        meta.deps.push((abs_src, spec.to_string()));
                    }
                }
            }
            Statement::ExportNamedDeclaration(d) => {
                for sp in &d.specifiers {
                    let local = export_name_str(&sp.local);
                    let exported = export_name_str(&sp.exported);
                    meta.exports.push((exported, local));
                }
            }
            Statement::ExportDefaultDeclaration(d) => match &d.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                    if let Some(i) = &f.id {
                        meta.exports
                            .push(("default".to_string(), i.name.to_string()));
                    } else {
                        meta.fallback = true; // anonymous default unsupported
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                    if let Some(i) = &c.id {
                        meta.exports
                            .push(("default".to_string(), i.name.to_string()));
                    } else {
                        meta.fallback = true;
                    }
                }
                _ => meta.fallback = true, // expression default export unsupported
            },
            Statement::ExportAllDeclaration(d) => {
                meta.fallback = true; // `export *` unsupported
                if let Some(spec) = d.source.value.as_str() {
                    if let Some(abs_src) = resolve(core, dir, spec) {
                        meta.deps.push((abs_src, spec.to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(meta)
}

/// Renames and strips import/export from a module body, then codegens it to a string.
fn render_body(core: &NowakiCore, abs: &Path, idx: usize, wiring: &ImportWiring) -> Result<String> {
    let allocator = Allocator::default();
    let source = core.read_source(abs)?;
    let source_type = crate::transform::source_type_for_path(abs);
    let mut program = crate::transform::parse_program(&allocator, abs, &source, source_type)?;
    let scoping = crate::transform::semantic_scoping(&program);
    let scoping =
        crate::transform::run_preact_transform(&allocator, abs, &source, scoping, &mut program)?;
    let scoping = crate::transform::apply_client_defines(
        &allocator,
        scoping,
        &mut program,
        &core.client_defines,
    );

    // Set of import local names (to tell them apart from own bindings)
    let mut import_locals: HashSet<String> = HashSet::new();
    for stmt in &program.body {
        if let Statement::ImportDeclaration(d) = stmt {
            if let Some(specs) = &d.specifiers {
                for s in specs {
                    import_locals.insert(import_spec_local(s));
                }
            }
        }
    }

    // Rename root-scope bindings:
    //   import binding -> wiring.rename_local (the dep's global name or the external import's alias)
    //   own binding    -> `<name>$<idx>`
    let mut scoping = scoping;
    let root = scoping.root_scope_id();
    let bindings: Vec<(String, _)> = scoping
        .get_bindings(root)
        .iter()
        .map(|(name, sym)| (name.to_string(), *sym))
        .collect();
    for (name, sym) in bindings {
        let new_name = if import_locals.contains(&name) {
            wiring.rename_local.get(&name).cloned()
        } else {
            Some(format!("{name}${idx}"))
        };
        if let Some(nn) = new_name {
            let taken = scoping.get_binding(root, nn.as_str().into()).is_some();
            let nn = allocator.alloc_str(&nn);
            if taken {
                // Two imports of one binding (`import { a, a as b }`, or a name and a barrel's
                // re-export of it) both print as that binding. Only the printed name changes;
                // the imports are stripped, so no duplicate declaration is emitted.
                scoping.set_symbol_name(sym, nn.into());
            } else {
                scoping.rename_symbol(sym, root, nn.into());
            }
        }
    }

    // Strip imports and turn exports into bare declarations.
    let mut new_body = oxc::allocator::Vec::new_in(&&allocator);
    for stmt in program.body.drain(..) {
        match stmt {
            Statement::ImportDeclaration(_) => { /* removed */ }
            Statement::ExportDeclaration(d) => {
                new_body.push(Statement::from(d.unbox().declaration))
            }
            // Specifiers only (`export {a}`): the binding already exists, so drop it
            Statement::ExportNamedDeclaration(_) | Statement::ExportFromDeclaration(_) => {}
            Statement::ExportDefaultDeclaration(d) => {
                let d = d.unbox();
                match d.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                        new_body.push(Statement::FunctionDeclaration(f));
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                        new_body.push(Statement::ClassDeclaration(c));
                    }
                    // Unreachable: expression default exports already fell back in extract_meta.
                    _ => {}
                }
            }
            other => new_body.push(other),
        }
    }
    program.body = new_body;

    let code = Codegen::new()
        .with_scoping(Some(scoping))
        .build(&program)
        .code;
    Ok(code)
}

fn resolve(core: &NowakiCore, dir: &Path, spec: &str) -> Option<PathBuf> {
    if crate::resolve::split_remote_spec(spec).is_some() {
        return core.resolve_spec(dir, spec);
    }
    if spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:") {
        return None;
    }
    let spec = crate::resolve::alias_specifier(spec).unwrap_or(spec);
    if let Some(shim) = crate::resolve::client_runtime_alias(&core.root, spec) {
        return Some(shim);
    }
    // resolve_spec tries normal resolution, then (on failure) plugin resolveId (virtual modules).
    core.resolve_spec(dir, spec)
}

fn export_name_str(n: &ModuleExportName) -> String {
    match n {
        ModuleExportName::IdentifierName(i) => i.name.to_string(),
        ModuleExportName::IdentifierReference(i) => i.name.to_string(),
        // Export names must be well-formed Unicode (an early error otherwise), so `display` is exact.
        ModuleExportName::StringLiteral(s) => s.value.display().to_string(),
    }
}

fn import_spec_local(s: &ImportDeclarationSpecifier) -> String {
    match s {
        ImportDeclarationSpecifier::ImportSpecifier(sp) => sp.local.name.to_string(),
        ImportDeclarationSpecifier::ImportDefaultSpecifier(sp) => sp.local.name.to_string(),
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(sp) => sp.local.name.to_string(),
    }
}

fn decl_bound_names(decl: &Declaration) -> Vec<String> {
    match decl {
        Declaration::VariableDeclaration(v) => v
            .declarations
            .iter()
            // Every name a destructuring pattern binds (`export const { a, b: c } = o`).
            .flat_map(|d| d.id.get_binding_identifiers())
            .map(|b| b.name.to_string())
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

fn order_modules(
    abs: &Path,
    metas: &HashMap<PathBuf, ModuleMeta>,
    order: &mut Vec<PathBuf>,
    visited: &mut HashSet<PathBuf>,
    stack: &mut HashSet<PathBuf>,
) {
    if visited.contains(abs) || stack.contains(abs) {
        return;
    }
    let Some(meta) = metas.get(abs) else { return };
    stack.insert(abs.to_path_buf());
    for (dep, _) in &meta.deps {
        if metas.contains_key(dep) {
            order_modules(dep, metas, order, visited, stack);
        }
    }
    stack.remove(abs);
    visited.insert(abs.to_path_buf());
    order.push(abs.to_path_buf());
}

/// Codegen options for client JS: minified, with a source map, keeping only legal comments.
/// Pass the minifier's scoping with `with_scoping`, or the mangled names are not printed.
pub(crate) fn client_codegen_options(source_map_path: PathBuf) -> CodegenOptions {
    CodegenOptions {
        minify: true,
        source_map_path: Some(source_map_path),
        // Nothing bundles the output again, so `/* @__PURE__ */` and other annotations are dead bytes.
        comments: CommentOptions {
            legal: LegalComment::Inline,
            ..CommentOptions::disabled()
        },
        ..CodegenOptions::default()
    }
}

/// Re-parses the concatenated chunk source, then minifies + codegens it (with an external source map).
/// Returns (final code, source map JSON).
pub fn minify_chunk(name: &str, source: &str) -> Result<(String, Option<String>)> {
    let allocator = Allocator::default();
    let path = Path::new(name);
    let mut program = crate::transform::parse_program(&allocator, path, source, SourceType::mjs())?;
    let minified = Minifier::new(MinifierOptions::default()).minify(&allocator, &mut program);
    let ret = Codegen::new()
        .with_options(client_codegen_options(PathBuf::from(name)))
        .with_scoping(minified.scoping)
        .build(&program);
    let map = ret.map.map(|m| m.to_json_string());
    let _ = xxh3_64(source.as_bytes());
    Ok((ret.code, map))
}
