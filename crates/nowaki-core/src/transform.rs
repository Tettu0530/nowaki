use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::{Program, Statement};
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::diagnostics::{GraphicalReportHandler, GraphicalTheme, NamedSource, OxcDiagnostic};
use oxc::parser::Parser;
use oxc::semantic::{Scoping, SemanticBuilder};
use oxc::span::SourceType;
use oxc::transformer::{JsxRuntime, TransformOptions, Transformer};
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
    // When transforming a server module (`"use server"`) for the browser, emit no implementation;
    // swap in a client proxy (tiny async functions that fetch). SSR keeps the real thing.
    if mode == Mode::Browser && crate::server_fn::has_use_server(source) {
        let key = crate::server_fn::module_key(root, path);
        let exports = crate::server_fn::collect_exports(path, source)?;
        return Ok(crate::server_fn::client_proxy(&key, &exports));
    }

    let allocator = Allocator::default();
    let mut program = parse_program(&allocator, path, source, source_type_for_path(path))?;
    let scoping = semantic_scoping(&program);
    let scoping = apply_client_defines(&allocator, scoping, &mut program, client_defines);
    run_preact_transform(&allocator, path, source, scoping, &mut program)?;

    if mode == Mode::Browser {
        rewrite_imports(&allocator, root, path, &mut program, resolver, vr);
    } else {
        // SSR: .css becomes a no-op, assets become URL-string data modules (so Node doesn't crash
        // importing svg etc. directly; the rendered <img src> matches the client).
        rewrite_ssr_imports(&allocator, root, path, &mut program, resolver, vr);
    }

    // No minification, so inline source map positions are exact.
    let ret = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
        .build(&program);
    let mut code = ret.code;
    if let Some(map) = ret.map {
        code.push_str("\n//# sourceMappingURL=");
        code.push_str(&map.to_data_url());
        code.push('\n');
    }
    Ok(code)
}

/// Rewrites top-level import / re-export specifiers to dev server URLs.
/// (Also catches the "preact/jsx-runtime" inserted by the automatic JSX transform.)
fn rewrite_imports<'a>(
    allocator: &'a Allocator,
    root: &Path,
    path: &Path,
    program: &mut Program<'a>,
    resolver: &Resolver,
    vr: Option<&dyn VirtualResolve>,
) {
    let dir = path.parent().unwrap_or(root);
    for stmt in program.body.iter_mut() {
        let source = match stmt {
            Statement::ImportDeclaration(decl) => Some(&mut decl.source),
            Statement::ExportNamedDeclaration(decl) => decl.source.as_mut(),
            Statement::ExportAllDeclaration(decl) => Some(&mut decl.source),
            _ => None,
        };
        let Some(lit) = source else { continue };
        if let Some(aliased) = crate::resolve::alias_specifier(lit.value.as_str()) {
            lit.value = allocator.alloc_str(aliased).into();
            lit.raw = None;
        }
        let Some(url) = map_specifier(lit.value.as_str(), dir, root, resolver, vr) else {
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

fn preact_transform_options() -> TransformOptions {
    let mut options = TransformOptions::default();
    options.jsx.runtime = JsxRuntime::Automatic;
    options.jsx.import_source = Some("preact".to_string());
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
    if !parsed.errors.is_empty() {
        return Err(anyhow!(
            "parse error\n{}",
            render_diagnostics(path, source, &parsed.errors)
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
    let ret = Transformer::new(allocator, path, &preact_transform_options())
        .build_with_scoping(scoping, program);
    if !ret.errors.is_empty() {
        return Err(anyhow!(
            "transform error\n{}",
            render_diagnostics(path, source, &ret.errors)
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
) -> Option<String> {
    if spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:") {
        return None;
    }
    match resolver.resolve(dir, spec) {
        Ok(resolution) => {
            let full = resolution.full_path();
            dev_asset_module(root, &full).or_else(|| Some(fs_path_to_url(root, &full)))
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
) {
    let dir = path.parent().unwrap_or(root);
    for stmt in program.body.iter_mut() {
        let source = match stmt {
            Statement::ImportDeclaration(decl) => Some(&mut decl.source),
            Statement::ExportNamedDeclaration(decl) => decl.source.as_mut(),
            Statement::ExportAllDeclaration(decl) => Some(&mut decl.source),
            _ => None,
        };
        let Some(lit) = source else { continue };
        // React packages → preact/compat (left bare for Node to resolve).
        if let Some(aliased) = crate::resolve::alias_specifier(lit.value.as_str()) {
            lit.value = allocator.alloc_str(aliased).into();
            lit.raw = None;
        }
        let spec = lit.value.as_str();
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
                if let Ok(css) = std::fs::read_to_string(&full) {
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
            let text = resolver
                .resolve(dir, spec)
                .ok()
                .and_then(|r| std::fs::read_to_string(r.full_path()).ok());
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
        if spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:") {
            continue;
        }
        if let Ok(resolution) = resolver.resolve(dir, spec) {
            let full = resolution.full_path();
            if let Some(data) = dev_asset_module(root, &full) {
                lit.value = allocator.alloc_str(&data).into();
                lit.raw = None;
            }
        }
    }
}

/// The data: module an asset import becomes in dev, for the browser and SSR alike: its URL, or for
/// `?image` the image set with `/__nowaki/image` URLs (sizes from the file header; the variants
/// are encoded when the browser asks). None when `full` isn't an asset.
fn dev_asset_module(root: &Path, full: &Path) -> Option<String> {
    let (file, query) = crate::image::split_query(full);
    if let Some(q) = query.as_deref().and_then(crate::image::image_query) {
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
        assert!(!parsed.errors.is_empty());
        let out = render_diagnostics(path, source, &parsed.errors);
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
}
