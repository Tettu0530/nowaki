use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::{Program, Statement};
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::diagnostics::{GraphicalReportHandler, GraphicalTheme, NamedSource, OxcDiagnostic};
use oxc::parser::Parser;
use oxc::semantic::{Scoping, SemanticBuilder};
use oxc::span::SourceType;
use oxc::transformer::{JsxRuntime, ReactRefreshOptions, TransformOptions, Transformer};
use oxc::transformer_plugins::{ReplaceGlobalDefines, ReplaceGlobalDefinesConfig};
use oxc_resolver::Resolver;

use crate::cache::Mode;
use crate::resolve::fs_path_to_url;

/// Plugin virtual-module resolution. Called for specifiers that normal resolution failed on.
/// Split into two methods because Browser and SSR produce different targets (dev URL vs data: module).
pub trait VirtualResolve {
    /// Browser: synthetic path of the virtual module (the caller turns it into a dev URL).
    fn virtual_browser(&self, dir: &Path, spec: &str) -> Option<PathBuf>;
    /// SSR: a data: module Node can import directly (self-contained ESM).
    fn virtual_ssr_module(&self, dir: &Path, spec: &str) -> Option<String>;
    /// A remote image import (`https://…?image`): the cached download with its `?image` query
    /// (see `NowakiCore::resolve_remote_image`). None for any other specifier.
    fn remote_image(&self, _spec: &str) -> Option<Result<PathBuf>> {
        None
    }
}

/// Transforms one file: TS type stripping + JSX (automatic, preact) + import rewriting (Browser only).
#[allow(clippy::too_many_arguments)]
pub fn transform_file(
    root: &Path,
    path: &Path,
    source: &str,
    mode: Mode,
    resolver: &Resolver,
    client_defines: &[(String, String)],
    vr: Option<&dyn VirtualResolve>,
) -> Result<String> {
    transform_file_with_inputs(root, path, source, mode, resolver, client_defines, vr)
        .map(|(code, _)| code)
}

/// [`transform_file`], plus the other files whose content the output inlines: CSS Module class
/// maps (the stylesheet and what it `@import`s), plain CSS text for SSR, and `?image` sizes. A
/// cache of the output must check these too, not only `source`.
#[allow(clippy::too_many_arguments)]
pub fn transform_file_with_inputs(
    root: &Path,
    path: &Path,
    source: &str,
    mode: Mode,
    resolver: &Resolver,
    client_defines: &[(String, String)],
    vr: Option<&dyn VirtualResolve>,
) -> Result<(String, Vec<PathBuf>)> {
    transform_file_dev(
        root,
        path,
        source,
        mode,
        resolver,
        client_defines,
        vr,
        DevBrowser::OFF,
    )
}

/// Dev-only extras for `nowaki dev`'s browser modules (`NowakiCore::set_dev_refresh`). Builds and
/// SSR never get them.
#[derive(Clone, Copy)]
pub(crate) struct DevBrowser<'v> {
    /// Fast Refresh registration (oxc's refresh transform plus the `client/refresh.js` import).
    pub refresh: bool,
    /// Hot module versions: an app module with a bumped version gets `?t=<n>` in the import URLs
    /// that name it, so the browser loads that module again (and only that one).
    pub versions: Option<&'v dashmap::DashMap<PathBuf, u64>>,
}

impl DevBrowser<'_> {
    pub(crate) const OFF: DevBrowser<'static> = DevBrowser {
        refresh: false,
        versions: None,
    };
}

/// The dev Fast Refresh runtime every refreshed module imports (served from the runtime package).
pub const REFRESH_RUNTIME_URL: &str = "/node_modules/@nowaki-dev/runtime/client/refresh.js";

/// Whether `path` is one of the app's own modules (not a dependency): the ones Fast Refresh
/// registers and hot versions apply to.
pub(crate) fn is_app_module(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .is_ok_and(|rel| !rel.components().any(|c| c.as_os_str() == "node_modules"))
}

/// [`transform_file_with_inputs`] with the dev browser extras in `dev` (ignored outside
/// `Mode::Browser`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn transform_file_dev(
    root: &Path,
    path: &Path,
    source: &str,
    mode: Mode,
    resolver: &Resolver,
    client_defines: &[(String, String)],
    vr: Option<&dyn VirtualResolve>,
    dev: DevBrowser<'_>,
) -> Result<(String, Vec<PathBuf>)> {
    let dev = if mode == Mode::Browser {
        dev
    } else {
        DevBrowser::OFF
    };
    let refresh = dev.refresh && is_app_module(root, path);
    // When transforming a server module (`"use server"`) for the browser, emit no implementation;
    // swap in a client proxy (tiny async functions that fetch). SSR keeps the real thing.
    if mode == Mode::Browser && crate::server_fn::has_use_server(source) {
        let key = crate::server_fn::module_key(root, path);
        let exports = crate::server_fn::collect_exports(path, source)?;
        let fn_path = crate::server_fn::fn_path(client_defines);
        return Ok((
            crate::server_fn::client_proxy_at(&key, &exports, &fn_path),
            Vec::new(),
        ));
    }
    // The dev browser asking for `@nowaki-dev/runtime/env/server`: a module that throws, so the
    // page shows the error instead of loading server values (the build refuses it outright).
    if mode == Mode::Browser && crate::env::is_server_env_module(path) {
        let msg = "@nowaki-dev/runtime/env/server is server-only and can't be imported from client code. Read server variables in a loader, action, or server function, or declare them as PUBLIC_* in env.ts (import.meta.env).";
        return Ok((format!("throw new Error({msg:?});\n"), Vec::new()));
    }
    let mut inputs = Vec::new();

    let allocator = Allocator::default();
    let mut program = parse_program(&allocator, path, source, source_type_for_path(path))?;
    let scoping = semantic_scoping(&program);
    let scoping = apply_client_defines(&allocator, scoping, &mut program, client_defines);
    run_preact_transform_with(&allocator, path, source, scoping, &mut program, refresh)?;

    if mode == Mode::Browser {
        rewrite_imports(
            &allocator,
            root,
            path,
            &mut program,
            resolver,
            vr,
            &mut inputs,
            dev.versions,
        );
    } else {
        // SSR: .css becomes a no-op, assets become URL-string data modules (so Node doesn't crash
        // importing svg etc. directly; the rendered <img src> matches the client).
        rewrite_ssr_imports(
            &allocator,
            root,
            path,
            &mut program,
            resolver,
            vr,
            &mut inputs,
        );
    }

    // No minification, so inline source map positions are exact.
    let ret = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
        .build(&program);
    let mut code = ret.code;
    if refresh && (code.contains("$RefreshReg$") || code.contains("$RefreshSig$")) {
        code.insert_str(0, &refresh_prelude(&fs_path_to_url(root, path)));
    }
    if let Some(map) = ret.map {
        code.push_str("\n//# sourceMappingURL=");
        code.push_str(&map.to_data_url());
        code.push('\n');
    }
    inputs.sort();
    inputs.dedup();
    Ok((code, inputs))
}

/// What a module with Fast Refresh registrations starts with: the runtime import, and a
/// `$RefreshReg$` that scopes each component id to this module's URL (so `Counter` in two files
/// is two families). One line with no newline, so the inline source map's lines stay exact.
fn refresh_prelude(module_url: &str) -> String {
    format!(
        "import {{ register as __nowaki_refresh_register, $RefreshSig$ }} from {REFRESH_RUNTIME_URL:?}; const $RefreshReg$ = (type, id) => __nowaki_refresh_register(type, {module_url:?} + \" \" + id); "
    )
}

/// Rewrites top-level import / re-export specifiers to dev server URLs.
/// (Also catches the "preact/jsx-runtime" inserted by the automatic JSX transform.)
#[allow(clippy::too_many_arguments)]
fn rewrite_imports<'a>(
    allocator: &'a Allocator,
    root: &Path,
    path: &Path,
    program: &mut Program<'a>,
    resolver: &Resolver,
    vr: Option<&dyn VirtualResolve>,
    inputs: &mut Vec<PathBuf>,
    versions: Option<&dashmap::DashMap<PathBuf, u64>>,
) {
    let dir = path.parent().unwrap_or(root);
    for stmt in program.body.iter_mut() {
        let source = match stmt {
            Statement::ImportDeclaration(decl) => Some(&mut decl.source),
            Statement::ExportFromDeclaration(decl) => Some(&mut decl.source),
            Statement::ExportAllDeclaration(decl) => Some(&mut decl.source),
            _ => None,
        };
        let Some(lit) = source else { continue };
        // A specifier with a lone surrogate isn't a path or package name: left as written.
        let Some(mut spec) = lit.value.as_str() else {
            continue;
        };
        if let Some(aliased) = crate::resolve::alias_specifier(spec) {
            lit.value = allocator.alloc_str(aliased).into();
            lit.raw = None;
            spec = aliased;
        }
        let Some(url) = map_specifier(spec, dir, root, resolver, vr, inputs, versions) else {
            continue;
        };
        lit.value = allocator.alloc_str(&url).into();
        lit.raw = None;
    }
}

/// Shared by dev transform, production build, and chunk render (defines before or after JSX per caller).
pub(crate) fn apply_client_defines<'a>(
    allocator: &'a Allocator,
    scoping: Scoping,
    program: &mut Program<'a>,
    defines: &[(String, String)],
) -> Scoping {
    if defines.is_empty() {
        return scoping;
    }
    match ReplaceGlobalDefinesConfig::new(defines) {
        Ok(config) => {
            ReplaceGlobalDefines::new(allocator, config)
                .build(scoping, program)
                .scoping
        }
        Err(_) => scoping, // pass through on invalid config
    }
}

/// oxc `SourceType` for a project file path (falls back to TSX).
pub(crate) fn source_type_for_path(path: &Path) -> SourceType {
    SourceType::from_path(path).unwrap_or_else(|_| SourceType::tsx())
}

/// `url` with the hot module version query (`?t=<n>`, or `&t=<n>` after an existing query).
pub(crate) fn with_version(url: &str, n: u64) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}t={n}")
}

fn preact_transform_options(refresh: bool) -> TransformOptions {
    let mut options = TransformOptions::default();
    options.jsx.runtime = JsxRuntime::Automatic;
    options.jsx.import_source = Some("preact".to_string());
    if refresh {
        options.jsx.refresh = Some(ReactRefreshOptions {
            refresh_reg: "$RefreshReg$".to_string(),
            refresh_sig: "$RefreshSig$".to_string(),
            // Readable hook signatures: client/refresh.js compares them as text.
            emit_full_signatures: true,
        });
    }
    options
}

/// Parses TS/JS source; on failure returns dev-style `parse error` diagnostics.
pub(crate) fn parse_program<'a>(
    allocator: &'a Allocator,
    path: &Path,
    source: &'a str,
    source_type: SourceType,
) -> Result<Program<'a>> {
    let parsed = Parser::new(allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(anyhow!(
            "parse error\n{}",
            render_diagnostics(path, source, &parsed.diagnostics)
        ));
    }
    Ok(parsed.program)
}

pub(crate) fn semantic_scoping(program: &Program<'_>) -> Scoping {
    SemanticBuilder::new()
        .build(program)
        .semantic
        .into_scoping()
}

/// TS strip + automatic JSX (preact). Preserves ordering: run after `apply_client_defines` in dev/build paths.
pub(crate) fn run_preact_transform<'a>(
    allocator: &'a Allocator,
    path: &Path,
    source: &str,
    scoping: Scoping,
    program: &mut Program<'a>,
) -> Result<Scoping> {
    run_preact_transform_with(allocator, path, source, scoping, program, false)
}

/// [`run_preact_transform`], plus oxc's React Refresh transform when `refresh` (dev browser only).
fn run_preact_transform_with<'a>(
    allocator: &'a Allocator,
    path: &Path,
    source: &str,
    scoping: Scoping,
    program: &mut Program<'a>,
    refresh: bool,
) -> Result<Scoping> {
    let ret = Transformer::new(allocator, path, &preact_transform_options(refresh))
        .build_with_scoping(scoping, program);
    if !ret.diagnostics.is_empty() {
        return Err(anyhow!(
            "transform error\n{}",
            render_diagnostics(path, source, &ret.diagnostics)
        ));
    }
    Ok(ret.scoping)
}

/// Formats oxc diagnostics as a code frame (file:line:col + caret). Shared by dev transform and production build.
pub(crate) fn render_diagnostics(path: &Path, source: &str, diags: &[OxcDiagnostic]) -> String {
    let handler = GraphicalReportHandler::new_themed(GraphicalTheme::unicode_nocolor());
    let name = path.to_string_lossy().to_string();
    let mut out = String::new();
    for diag in diags {
        let report = diag
            .clone()
            .with_source_code(NamedSource::new(name.clone(), source.to_string()));
        let _ = handler.render_report(&mut out, report.as_ref());
    }
    if out.trim().is_empty() {
        out = diags
            .iter()
            .map(|d| d.to_string())
            .collect::<Vec<_>>()
            .join("; ");
    }
    out
}

/// Resolves a specifier to a URL. None if no rewrite is needed or possible.
/// Assets (images, fonts, etc.) are wrapped in a data module that default-exports the URL string.
fn map_specifier(
    spec: &str,
    dir: &Path,
    root: &Path,
    resolver: &Resolver,
    vr: Option<&dyn VirtualResolve>,
    inputs: &mut Vec<PathBuf>,
    versions: Option<&dashmap::DashMap<PathBuf, u64>>,
) -> Option<String> {
    if let Some(r) = vr.and_then(|v| v.remote_image(spec)) {
        return Some(remote_image_module(root, spec, r, inputs));
    }
    if spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:") {
        return None;
    }
    match resolver.resolve(dir, spec) {
        Ok(resolution) => {
            let full = resolution.full_path();
            dev_asset_module(root, &full, inputs).or_else(|| {
                let url = fs_path_to_url(root, &full);
                let version = versions.and_then(|v| v.get(&full).map(|n| *n));
                Some(match version {
                    Some(n) if is_app_module(root, &full) => with_version(&url, n),
                    _ => url,
                })
            })
        }
        Err(err) => {
            // Virtual modules get a dev URL for their synthetic path; the dev server serves them via load.
            if let Some(p) = vr.and_then(|v| v.virtual_browser(dir, spec)) {
                return Some(fs_path_to_url(root, &p));
            }
            eprintln!(
                "[nowaki] failed to resolve {spec} (from {}): {err}",
                dir.display()
            );
            None
        }
    }
}

/// Returns a data: module with an arbitrary JS body (importable from both Node and the browser).
pub(crate) fn data_module(body: &str) -> String {
    format!("data:text/javascript,{}", percent_encode_js(body))
}

/// Returns, as a data: URI, a tiny JS module that default-exports the asset's served URL.
/// `import logo from "./logo.png"` → logo === "<asset url>" (the binary is served separately).
pub(crate) fn asset_module_data_url(url: &str) -> String {
    data_module(&format!("export default {url:?}"))
}

/// Minimal percent-encoding that is safe for a data: URI body.
fn percent_encode_js(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// For SSR: rewrites `.css` side-effect imports to an empty module and asset imports to URL-string
/// data modules (the server has no DOM; Node can't import svg etc.).
fn rewrite_ssr_imports<'a>(
    allocator: &'a Allocator,
    root: &Path,
    path: &Path,
    program: &mut Program<'a>,
    resolver: &Resolver,
    vr: Option<&dyn VirtualResolve>,
    inputs: &mut Vec<PathBuf>,
) {
    let dir = path.parent().unwrap_or(root);
    for stmt in program.body.iter_mut() {
        let source = match stmt {
            Statement::ImportDeclaration(decl) => Some(&mut decl.source),
            Statement::ExportFromDeclaration(decl) => Some(&mut decl.source),
            Statement::ExportAllDeclaration(decl) => Some(&mut decl.source),
            _ => None,
        };
        let Some(lit) = source else { continue };
        // A specifier with a lone surrogate isn't a path or package name: left as written.
        let Some(mut spec) = lit.value.as_str() else {
            continue;
        };
        // React packages → preact/compat (left bare for Node to resolve).
        if let Some(aliased) = crate::resolve::alias_specifier(spec) {
            lit.value = allocator.alloc_str(aliased).into();
            lit.raw = None;
            spec = aliased;
        }
        // Inline virtual modules as data: (assumed self-contained ESM). Checked before bare resolution.
        if !spec.starts_with('.') && !spec.starts_with('/') && !spec.contains("://") {
            if let Some(data) = vr.and_then(|v| v.virtual_ssr_module(dir, spec)) {
                lit.value = allocator.alloc_str(&data).into();
                lit.raw = None;
                continue;
            }
        }
        // CSS Modules: SSR gets only the class name map (injection happens on the client).
        if spec.ends_with(".module.css") {
            if let Ok(resolution) = resolver.resolve(dir, spec) {
                let full = resolution.full_path();
                // `@import`s inlined, as the browser's stylesheet has them (else the map lacks
                // the imported classes).
                if let Some(css) = read_css_inlined(resolver, &full, inputs) {
                    let id = crate::css::css_scope_id(root, &full);
                    let (_scoped, map) = crate::css::scope_css(&id, &css);
                    let body = format!("export default {}", crate::css::mapping_object(&map));
                    lit.value = allocator.alloc_str(&data_module(&body)).into();
                    lit.raw = None;
                }
            }
            continue;
        }
        // Plain CSS: SSR gets its text as the default export (`import css from "./a.css"` is a
        // string, as nowaki-env.d.ts says); the page links it as a stylesheet (route CSS).
        if spec.ends_with(".css") {
            let text = resolver.resolve(dir, spec).ok().and_then(|r| {
                let full = r.full_path();
                inputs.push(full.clone());
                std::fs::read_to_string(full).ok()
            });
            let module = match text {
                Some(css) => {
                    data_module(&format!("export default {}", crate::css::js_string(&css)))
                }
                None => crate::css::CSS_NOOP_SPECIFIER.to_string(),
            };
            lit.value = allocator.alloc_str(&module).into();
            lit.raw = None;
            continue;
        }
        if let Some(r) = vr.and_then(|v| v.remote_image(spec)) {
            let data = remote_image_module(root, spec, r, inputs);
            lit.value = allocator.alloc_str(&data).into();
            lit.raw = None;
            continue;
        }
        if spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:") {
            continue;
        }
        if let Ok(resolution) = resolver.resolve(dir, spec) {
            let full = resolution.full_path();
            if let Some(data) = dev_asset_module(root, &full, inputs) {
                lit.value = allocator.alloc_str(&data).into();
                lit.raw = None;
            }
        }
    }
}

/// A stylesheet with its `@import`s inlined, like `NowakiCore::read_css`. Adds the stylesheet and
/// every file it inlined to `inputs`.
fn read_css_inlined(resolver: &Resolver, abs: &Path, inputs: &mut Vec<PathBuf>) -> Option<String> {
    inputs.push(abs.to_path_buf());
    let css = std::fs::read_to_string(abs).ok()?;
    if !css.contains("@import") {
        return Some(css);
    }
    let resolve = |dir: &Path, spec: &str| resolver.resolve(dir, spec).ok().map(|r| r.full_path());
    let (css, inlined) = crate::css::inline_imports_with_files(abs, &css, &resolve);
    inputs.extend(inlined);
    Some(css)
}

/// The dev module for a remote image import: the image set of its cached download, or a module
/// that throws why it isn't available (not allowed, the fetch failed). A failure lists the cache
/// entry as an input, so the module is rebuilt once the download exists.
fn remote_image_module(
    root: &Path,
    spec: &str,
    resolved: Result<PathBuf>,
    inputs: &mut Vec<PathBuf>,
) -> String {
    let err = match resolved {
        Ok(full) => match dev_asset_module(root, &full, inputs) {
            Some(data) => return data,
            None => anyhow!("{spec}: not an image"),
        },
        Err(e) => e,
    };
    if let Some((url, _)) = crate::resolve::split_remote_spec(spec) {
        inputs.push(crate::remote_image::meta_path(root, url));
    }
    let msg = format!("{err:#}");
    eprintln!("[nowaki] {msg}");
    data_module(&format!("throw new Error({msg:?});"))
}

/// The data: module an asset import becomes in dev, for the browser and SSR alike: its URL, or for
/// `?image` the image set with `/__nowaki/image` URLs (sizes from the file header; the variants
/// are encoded when the browser asks). None when `full` isn't an asset.
/// For `?image`, the file goes into `inputs` (its sizes are inlined).
fn dev_asset_module(root: &Path, full: &Path, inputs: &mut Vec<PathBuf>) -> Option<String> {
    let (file, query) = crate::image::split_query(full);
    if let Some(q) = query.as_deref().and_then(crate::image::image_query) {
        inputs.push(file.clone());
        return match crate::image::dev_set(root, &file, &q) {
            Ok(set) => Some(data_module(set.module().trim_end())),
            Err(e) => {
                eprintln!("[nowaki] {}: {e}", file.display());
                None
            }
        };
    }
    let file = if crate::is_asset(&file) {
        file
    } else {
        full.to_path_buf()
    };
    crate::is_asset(&file).then(|| asset_module_data_url(&fs_path_to_url(root, &file)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc::allocator::Allocator;
    use oxc::parser::Parser;
    use oxc::span::SourceType;

    #[test]
    fn render_diagnostics_includes_named_source() {
        let path = Path::new("/app/islands/Broken.tsx");
        let source = "export default () => <;\n";
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
        assert!(!parsed.diagnostics.is_empty());
        let out = render_diagnostics(path, source, &parsed.diagnostics);
        assert!(
            out.contains("Broken.tsx") || out.contains('╭') || out.contains('|'),
            "expected a code frame, got: {out}"
        );
    }

    #[test]
    fn parse_transform_pipeline_strips_types_and_jsx() {
        let path = Path::new("/app/islands/Counter.tsx");
        let source = "const n: number = 1;\nexport default function C() { return <p>{n}</p>; }\n";
        let allocator = Allocator::default();
        let mut program =
            parse_program(&allocator, path, source, source_type_for_path(path)).unwrap();
        let scoping = semantic_scoping(&program);
        let scoping = apply_client_defines(&allocator, scoping, &mut program, &[]);
        run_preact_transform(&allocator, path, source, scoping, &mut program).unwrap();
        let code = Codegen::new().build(&program).code;
        assert!(!code.contains(": number"));
        assert!(code.contains("jsx"));
    }

    /// An app with an island importing a util and a store, for the dev refresh tests.
    fn refresh_app() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join("islands")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
        std::fs::write(
            root.join("islands/Counter.tsx"),
            "import { useState } from \"preact/hooks\";\nimport { label } from \"./util.ts\";\nimport { store } from \"./store.ts\";\nexport default function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>{label(n)}{store.x}</button>;\n}\n",
        )
        .unwrap();
        std::fs::write(
            root.join("islands/util.ts"),
            "export const label = (n: number) => `n=${n}`;\n",
        )
        .unwrap();
        std::fs::write(
            root.join("islands/store.ts"),
            "export const store = { x: 1 };\n",
        )
        .unwrap();
        std::fs::write(
            root.join("node_modules/dep/package.json"),
            r#"{"name":"dep","type":"module","main":"index.jsx"}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("node_modules/dep/index.jsx"),
            "export default function Dep() { return <i>dep</i>; }\n",
        )
        .unwrap();
        (tmp, root)
    }

    #[test]
    fn dev_refresh_registers_app_components_in_browser_mode_only() {
        let (_tmp, root) = refresh_app();
        let island = root.join("islands/Counter.tsx");
        let mut core = crate::NowakiCore::new(root.clone());

        // Off (the default, and what every build uses): no refresh code anywhere.
        let plain = core.load_module(&island, Mode::Browser).unwrap();
        assert!(!plain.contains("$RefreshReg$"), "{plain}");

        core.set_dev_refresh(true);
        let browser = core.load_module(&island, Mode::Browser).unwrap();
        assert!(
            browser.starts_with(&format!(
                "import {{ register as __nowaki_refresh_register, $RefreshSig$ }} from \"{REFRESH_RUNTIME_URL}\";"
            )),
            "{browser}"
        );
        // Component ids are scoped to the module URL; hook signatures are readable.
        assert!(
            browser.contains("\"/islands/Counter.tsx\" + \" \" + id"),
            "{browser}"
        );
        assert!(
            browser.contains("$RefreshReg$(_c, \"Counter\")"),
            "{browser}"
        );
        assert!(browser.contains("useState{"), "{browser}");
        // The prelude adds no line, so the inline source map still lines up.
        assert!(!refresh_prelude("/x.tsx").contains('\n'));

        let ssr = core.load_module(&island, Mode::Ssr).unwrap();
        assert!(!ssr.contains("$Refresh"), "{ssr}");
        // A module with no component gets no prelude; dependencies are never refreshed.
        let util = core
            .load_module(&root.join("islands/util.ts"), Mode::Browser)
            .unwrap();
        assert!(!util.contains("refresh.js"), "{util}");
        let dep = core
            .load_module(&root.join("node_modules/dep/index.jsx"), Mode::Browser)
            .unwrap();
        assert!(!dep.contains("$Refresh"), "{dep}");
    }

    #[test]
    fn bundle_transforms_never_get_refresh_code() {
        let (_tmp, root) = refresh_app();
        let mut core = crate::NowakiCore::new(root.clone());
        core.set_dev_refresh(true);
        let island = root.join("islands/Counter.tsx");
        let source = std::fs::read_to_string(&island).unwrap();
        let allocator = Allocator::default();
        let mut program =
            parse_program(&allocator, &island, &source, source_type_for_path(&island)).unwrap();
        let scoping = semantic_scoping(&program);
        run_preact_transform(&allocator, &island, &source, scoping, &mut program).unwrap();
        let code = Codegen::new().build(&program).code;
        assert!(!code.contains("$Refresh"), "{code}");
        // The public transform entry points (no dev extras) neither.
        let out = transform_file(
            &root,
            &island,
            &source,
            Mode::Browser,
            &crate::resolve::make_resolver(),
            &[],
            None,
        )
        .unwrap();
        assert!(!out.contains("$Refresh"), "{out}");
    }

    #[test]
    fn hot_versions_only_on_bumped_app_modules() {
        let (_tmp, root) = refresh_app();
        let mut core = crate::NowakiCore::new(root.clone());
        core.set_dev_refresh(true);
        let island = root.join("islands/Counter.tsx");
        let before = core.load_module(&island, Mode::Browser).unwrap();
        assert!(before.contains("\"/islands/util.ts\""), "{before}");

        // The util changed: it and its importer get versions; the store keeps its URL.
        let util_v = core.bump_dev_version(&root.join("islands/util.ts"));
        let island_v = core.bump_dev_version(&island);
        assert_ne!(util_v, island_v);
        assert_eq!(
            core.dev_module_url(&island),
            format!("/islands/Counter.tsx?t={island_v}")
        );
        let after = core.load_module(&island, Mode::Browser).unwrap();
        assert!(
            after.contains(&format!("\"/islands/util.ts?t={util_v}\"")),
            "{after}"
        );
        assert!(after.contains("\"/islands/store.ts\""), "{after}");
        assert!(
            !after.contains("preact/hooks?t") && !after.contains(".js?t="),
            "{after}"
        );
        // SSR output has no versions.
        let ssr = core.load_module(&island, Mode::Ssr).unwrap();
        assert!(!ssr.contains("?t="), "{ssr}");
        assert_eq!(with_version("/a.css?x=1", 3), "/a.css?x=1&t=3");
    }
}
