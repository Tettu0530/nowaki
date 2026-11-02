//! Production build: walks the client module graph, transforms + minifies, and
//! writes content-hashed ESM to dist/client/.
//! Per island, app modules used only by that island are concatenated into one scope
//! (scope hoisting, chunk.rs). node_modules/shared/css/asset become separate chunks,
//! shared and deduped. Modules that can't be concatenated fall back to unbundled emit.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::Statement;
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::minifier::{Minifier, MinifierOptions};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{JsxRuntime, TransformOptions, Transformer};
use xxhash_rust::xxh3::xxh3_64;

use crate::NowakiCore;

pub struct BuildReport {
    pub modules: usize,
    pub islands: usize,
    pub server_modules: usize,
    pub out_dir: PathBuf,
    /// Total input/output bytes of image optimization (for reporting savings).
    pub asset_in: u64,
    pub asset_out: u64,
}

/// Walks the graph from the entries (islands runtime + islands/),
/// writes to dist/client/, and writes manifest.json.
/// Also returns an "asset absolute path → served URL" map (shared with the server build).
pub fn build_client(
    core: &NowakiCore,
    dist: &Path,
) -> Result<(BuildReport, HashMap<PathBuf, String>)> {
    let client_dir = dist.join("client");
    fs::create_dir_all(&client_dir)
        .with_context(|| format!("failed to create dist: {}", client_dir.display()))?;

    let mut ctx = EmitCtx::default();

    // Entry 1: the eager client runtime (islands.js = hydration only).
    // Only pages with islands load it. The SPA router is excluded to keep first-load minimal.
    let runtime = core
        .root
        .join("node_modules/@nowaki-dev/runtime/client/islands.js");
    let runtime_out = if runtime.exists() {
        Some(emit(core, &runtime, &client_dir, &mut ctx)?)
    } else {
        None
    };

    // Separate chunk: the SPA router (Router Cache / loading / error / click interception).
    // islands.js lazy-imports it on idle after hydration (not part of first-load).
    let router = core
        .root
        .join("node_modules/@nowaki-dev/runtime/client/router.js");
    let router_runtime_out = if runtime_out.is_some() && router.exists() {
        Some(emit(core, &router, &client_dir, &mut ctx)?)
    } else {
        None
    };

    // Entries 2..: each component under islands/.
    let mut islands: Vec<(String, String)> = Vec::new();
    let mut live_islands: Vec<String> = Vec::new();
    let islands_dir = core.root.join("islands");
    if islands_dir.is_dir() {
        // Live islands (server-reactive) ship no JS to the client. Separate them out first.
        let all: Vec<PathBuf> = {
            let mut v: Vec<PathBuf> = fs::read_dir(&islands_dir)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| crate::is_transformable(p))
                .collect();
            v.sort();
            v
        };
        let mut entries: Vec<PathBuf> = Vec::new();
        for p in all {
            let name = p
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("island")
                .to_string();
            if is_live_island(core, &p) {
                live_islands.push(name); // no client chunk
            } else {
                entries.push(p);
            }
        }

        // Compute each island's reachable app set and count sharing (reached from multiple islands).
        let reach: Vec<(PathBuf, HashSet<PathBuf>)> = entries
            .iter()
            .map(|e| (e.clone(), crate::chunk::collect_app_modules(core, e)))
            .collect();
        let mut app_count: HashMap<PathBuf, usize> = HashMap::new();
        for (_, set) in &reach {
            for m in set {
                *app_count.entry(m.clone()).or_default() += 1;
            }
        }

        for (island, set) in &reach {
            let name = island
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("island")
                .to_string();
            let out = emit_island(core, island, set, &app_count, &client_dir, &mut ctx)?;
            islands.push((name, out));
        }
    }

    let live_runtime_out = if !live_islands.is_empty() {
        let live_rt = core
            .root
            .join("node_modules/@nowaki-dev/runtime/client/live.js");
        if live_rt.exists() {
            Some(emit(core, &live_rt, &client_dir, &mut ctx)?)
        } else {
            None
        }
    } else {
        None
    };

    fs::write(
        client_dir.join("manifest.json"),
        render_manifest(
            runtime_out.as_deref(),
            router_runtime_out.as_deref(),
            &islands,
            &live_islands,
            live_runtime_out.as_deref(),
            &ctx.deps,
        ),
    )?;

    Ok((
        BuildReport {
            modules: ctx.emitted.len(),
            islands: islands.len(),
            server_modules: 0,
            out_dir: client_dir,
            asset_in: ctx.asset_in,
            asset_out: ctx.asset_out,
        },
        ctx.assets,
    ))
}

/// Server build: transforms routes/ and islands/ in SSR mode and
/// writes them to dist/server/ as ESM that Node can run directly.
/// Rewrites .tsx/.ts/.jsx in relative imports to .js (bare imports are left to Node resolution).
/// Returns the number of output modules.
pub fn build_server(
    core: &NowakiCore,
    dist: &Path,
    assets: &HashMap<PathBuf, String>,
) -> Result<usize> {
    use rayon::prelude::*;

    let server_dir = dist.join("server");
    let mut files = Vec::new();
    for sub in ["routes", "islands", "components", "lib", "actions"] {
        let src_root = core.root.join(sub);
        if !src_root.is_dir() {
            continue;
        }
        for path in walk_files(&src_root)? {
            if crate::is_transformable(&path) {
                files.push(path);
            }
        }
    }

    // Server modules are independent (no naming dependencies), so transform them in parallel with rayon.
    let results: Vec<Result<(PathBuf, String)>> = files
        .par_iter()
        .map(|path| {
            let rel = path
                .strip_prefix(&core.root)
                .with_context(|| format!("failed to relativize: {}", path.display()))?;
            let out_path = server_dir.join(with_js_ext(rel));
            let source = core.read_source(path)?;
            let code = transform_for_server(path, &source, core, assets)?;
            Ok((out_path, code))
        })
        .collect();

    let mut count = 0;
    for r in results {
        let (out_path, code) = r?;
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&out_path, code)?;
        count += 1;
    }

    // Write the server function (`"use server"`) allowlist to dist/server/functions.json.
    // The runtime dispatches via this id→{module,export} (the client can't call arbitrary exports).
    // Kept out of the client manifest (so the server's file layout isn't exposed).
    write_server_functions(core, &server_dir)?;

    Ok(count)
}

/// Generates dist/server/functions.json. module is a .js path relative to serverDir.
fn write_server_functions(core: &NowakiCore, server_dir: &Path) -> Result<()> {
    let found =
        crate::server_fn::discover(core, &["routes", "islands", "components", "lib", "actions"]);
    let mut entries: Vec<String> = Vec::new();
    for f in &found {
        let module_js = with_js_suffix(&f.source_rel);
        entries.push(format!(
            "  \"{}\": {{ \"module\": \"{}\", \"export\": \"{}\" }}",
            f.id, module_js, f.export
        ));
    }
    let json = format!("{{\n{}\n}}\n", entries.join(",\n"));
    fs::write(server_dir.join("functions.json"), json)?;
    Ok(())
}

/// Replaces the extension of a posix relative path with .js (`actions/x.ts` → `actions/x.js`).
fn with_js_suffix(rel: &str) -> String {
    match rel.rfind('.') {
        Some(i) if !rel[i..].contains('/') => format!("{}.js", &rel[..i]),
        _ => format!("{rel}.js"),
    }
}

/// SSR transform: TS stripping + JSX (automatic, preact) + relative imports to .js.
/// Not minified (keeps SSR stack traces readable).
fn transform_for_server(
    path: &Path,
    source: &str,
    core: &NowakiCore,
    assets: &HashMap<PathBuf, String>,
) -> Result<String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::tsx());

    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.errors.is_empty() {
        let msgs: Vec<String> = parsed.errors.iter().map(|e| e.to_string()).collect();
        return Err(anyhow!(
            "parse error in {}: {}",
            path.display(),
            msgs.join("; ")
        ));
    }
    let mut program = parsed.program;

    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();
    let scoping = crate::transform::apply_client_defines(
        &allocator,
        scoping,
        &mut program,
        &core.client_defines,
    );

    let mut options = TransformOptions::default();
    options.jsx.runtime = JsxRuntime::Automatic;
    options.jsx.import_source = Some("preact".to_string());
    let ret =
        Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !ret.errors.is_empty() {
        let msgs: Vec<String> = ret.errors.iter().map(|e| e.to_string()).collect();
        return Err(anyhow!(
            "transform error in {}: {}",
            path.display(),
            msgs.join("; ")
        ));
    }

    let dir = path.parent().unwrap_or(&core.root);
    for stmt in program.body.iter_mut() {
        let source_lit = match stmt {
            Statement::ImportDeclaration(d) => Some(&mut d.source),
            Statement::ExportNamedDeclaration(d) => d.source.as_mut(),
            Statement::ExportAllDeclaration(d) => Some(&mut d.source),
            _ => None,
        };
        let Some(lit) = source_lit else { continue };
        // React packages → preact/compat (left bare for Node to resolve).
        if let Some(aliased) = crate::resolve::alias_specifier(lit.value.as_str()) {
            lit.value = allocator.alloc_str(aliased).into();
            lit.raw = None;
        }
        let spec = lit.value.as_str();
        // Inline virtual modules as data: (assumed self-contained ESM).
        if !spec.starts_with('.') && !spec.starts_with('/') && !spec.contains("://") {
            if let Some(data) = core.virtual_ssr_module(dir, spec) {
                lit.value = allocator.alloc_str(&data).into();
                lit.raw = None;
                continue;
            }
        }
        // CSS Modules: SSR gets only the class name map (no DOM, so no injection).
        if spec.ends_with(".module.css") {
            if let Ok(resolution) = core.resolver.resolve(dir, spec) {
                let full = resolution.full_path();
                if let Ok(css) = fs::read_to_string(&full) {
                    // Scope with the same id as the client so class names match.
                    let id = crate::css::css_scope_id(&core.root, &full);
                    let (_scoped, map) = crate::css::scope_css(&id, &css);
                    let body = format!("export default {}", crate::css::mapping_object(&map));
                    let data = crate::transform::data_module(&body);
                    lit.value = allocator.alloc_str(&data).into();
                    lit.raw = None;
                }
            }
            continue;
        }
        // Assets: point at the client build's hashed URL (basename if missing).
        if !spec.starts_with('/') && !spec.contains("://") && !spec.starts_with("data:") {
            if let Ok(resolution) = core.resolver.resolve(dir, spec) {
                let full = resolution.full_path();
                if crate::is_asset(&full) {
                    let url = assets.get(&full).cloned().unwrap_or_else(|| {
                        format!(
                            "/_nowaki/{}",
                            full.file_name().and_then(|n| n.to_str()).unwrap_or("asset")
                        )
                    });
                    let data = crate::transform::asset_module_data_url(&url);
                    lit.value = allocator.alloc_str(&data).into();
                    lit.raw = None;
                    continue;
                }
            }
        }
        if let Some(rewritten) = rewrite_server_spec(spec) {
            lit.value = allocator.alloc_str(&rewritten).into();
            lit.raw = None;
        }
    }

    // SSR isn't minified, so the inline source map is exact (for node --enable-source-maps).
    // Don't expose absolute paths of out-of-root deps (dist/server isn't served, but kept consistent).
    let rel = client_source_name(&core.root, path);
    let ret = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(rel),
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

/// Rewrites TS extensions in relative local imports to .js. Leaves bare/absolute/.js alone.
fn rewrite_server_spec(spec: &str) -> Option<String> {
    if !spec.starts_with('.') {
        return None;
    }
    if spec.ends_with(".css") {
        // CSS is client-only
        return Some(crate::css::CSS_NOOP_SPECIFIER.to_string());
    }
    for ext in [".tsx", ".jsx", ".ts", ".tsrx"] {
        if let Some(stem) = spec.strip_suffix(ext) {
            return Some(format!("{stem}.js"));
        }
    }
    None
}

fn with_js_ext(rel: &Path) -> PathBuf {
    rel.with_extension("js")
}

fn walk_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            out.extend(walk_files(&path)?);
        } else {
            out.push(path);
        }
    }
    Ok(out)
}

/// Mutable state while walking the output graph. Reused within one build.
#[derive(Default)]
struct EmitCtx {
    emitted: HashMap<PathBuf, String>,
    /// Modules currently on the DFS stack (for cycle detection)
    visiting: HashSet<PathBuf>,
    assets: HashMap<PathBuf, String>,
    /// Provisional pre-rewrite file names used for cycles
    provisional: HashMap<PathBuf, String>,
    /// Modules found to be part of a cycle (their provisional name becomes final)
    cyclic: HashSet<PathBuf>,
    /// Output file name → output file names of direct deps (for computing preload chains)
    deps: HashMap<String, Vec<String>>,
    asset_in: u64,
    asset_out: u64,
}

/// Name to put in the source map's `sources`. Made root-relative so the client .map doesn't
/// expose absolute paths (OS user name, home directory layout). Out-of-root paths
/// (pnpm store etc.) are trimmed to `node_modules/...` onward, or to just the file name otherwise.
fn client_source_name(root: &Path, path: &Path) -> PathBuf {
    if let Ok(rel) = path.strip_prefix(root) {
        return rel.to_path_buf();
    }
    let s = path.to_string_lossy();
    if let Some(idx) = s.rfind("node_modules/") {
        return PathBuf::from(&s[idx..]);
    }
    PathBuf::from(path.file_name().unwrap_or(path.as_os_str()))
}

/// Emits one module (after processing its deps) and returns the output file name.
/// Acyclic modules are named by the hash of their final content (correct for immutable caching). Cycles
/// fall back to a provisional name from the pre-rewrite hash (still post-order DFS).
fn emit(core: &NowakiCore, abs: &Path, out_dir: &Path, ctx: &mut EmitCtx) -> Result<String> {
    if let Some(name) = ctx.emitted.get(abs) {
        return Ok(name.clone());
    }
    // Assets (images, fonts, etc.): copy raw with a content hash and
    // emit a tiny JS module that default-exports the served URL (no deps).
    if crate::is_asset(abs) {
        let raw = fs::read(abs).with_context(|| format!("failed to read: {}", abs.display()))?;
        let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("bin");
        let stem = abs.file_stem().and_then(|s| s.to_str()).unwrap_or("asset");
        let (bytes, out_ext) =
            crate::asset::optimize(&raw, ext, &crate::asset::Transform::default());
        ctx.asset_in += raw.len() as u64;
        ctx.asset_out += bytes.len() as u64;
        let asset_hash = xxh3_64(&bytes) as u32;
        let asset_name = format!("{stem}.{asset_hash:08x}.{out_ext}");
        fs::write(out_dir.join(&asset_name), &bytes)?;
        let url = format!("/_nowaki/{asset_name}");
        ctx.assets.insert(abs.to_path_buf(), url.clone());
        let code = format!("export default \"{url}\";\n");
        let mod_hash = xxh3_64(code.as_bytes()) as u32;
        let mod_name = format!("{stem}.{out_ext}.{mod_hash:08x}.js");
        fs::write(out_dir.join(&mod_name), &code)?;
        ctx.deps.insert(mod_name.clone(), Vec::new());
        ctx.emitted.insert(abs.to_path_buf(), mod_name.clone());
        return Ok(mod_name);
    }
    // .css becomes a <style>-injecting JS shim; *.module.css is scoped + exports a class name map (no deps).
    if crate::css::is_css(abs) {
        let css = fs::read_to_string(abs)
            .with_context(|| format!("failed to read: {}", abs.display()))?;
        let id = crate::css::css_scope_id(&core.root, abs);
        let code = if crate::css::is_css_module(abs) {
            let (scoped, map) = crate::css::scope_css(&id, &css);
            crate::css::css_module_client_js(&id, &scoped, &map)
        } else {
            crate::css::css_shim(&id, &css)
        };
        let hash = xxh3_64(code.as_bytes()) as u32;
        let stem = abs.file_stem().and_then(|s| s.to_str()).unwrap_or("style");
        let filename = format!("{stem}.css.{hash:08x}.js");
        fs::write(out_dir.join(&filename), &code)?;
        ctx.deps.insert(filename.clone(), Vec::new());
        ctx.emitted.insert(abs.to_path_buf(), filename.clone());
        return Ok(filename);
    }
    // Cycle: a back-edge to a module already on the DFS stack. Return its provisional name and
    // add it to cyclic, pinning its final name to the provisional one.
    if ctx.visiting.contains(abs) {
        ctx.cyclic.insert(abs.to_path_buf());
        return Ok(ctx
            .provisional
            .get(abs)
            .cloned()
            .expect("provisional is set while visiting"));
    }
    ctx.visiting.insert(abs.to_path_buf());

    let source = core.read_source(abs)?;
    // Server module (`"use server"`): emit a proxy (a dependency-free leaf) instead of the
    // implementation. Server-only deps stop here and never enter the client graph.
    if crate::server_fn::has_use_server(&source) {
        ctx.visiting.remove(abs);
        let key = crate::server_fn::module_key(&core.root, abs);
        let exports = crate::server_fn::collect_exports(abs, &source)?;
        let code = crate::server_fn::client_proxy(&key, &exports);
        let stem = abs.file_stem().and_then(|s| s.to_str()).unwrap_or("module");
        let hash = xxh3_64(code.as_bytes()) as u32;
        let filename = format!("{stem}.{hash:08x}.js");
        fs::write(out_dir.join(&filename), &code)?;
        ctx.deps.insert(filename.clone(), Vec::new());
        ctx.emitted.insert(abs.to_path_buf(), filename.clone());
        return Ok(filename);
    }
    let module = transform_for_bundle(abs, &source, core)?;
    let stem = abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("module")
        .to_string();

    // Fix the provisional name from the pre-rewrite hash first (so back-edges can reference it).
    let prov_hash = xxh3_64(module.code.as_bytes()) as u32;
    let prov = format!("{stem}.{prov_hash:08x}.js");
    ctx.provisional.insert(abs.to_path_buf(), prov.clone());

    let mut code = module.code;
    let mut dep_names = Vec::new();
    for dep in &module.deps {
        let dep_name = emit(core, &dep.abs_path, out_dir, ctx)?;
        code = code.replace(&dep.placeholder, &format!("./{dep_name}"));
        dep_names.push(dep_name);
    }
    ctx.visiting.remove(abs);

    let filename = if ctx.cyclic.contains(abs) {
        // Cycle: back-edges already reference the provisional name, so make it final.
        prov
    } else {
        let hash = xxh3_64(code.as_bytes()) as u32;
        format!("{stem}.{hash:08x}.js")
    };

    // External source map (sourcesContent embedded). Columns are approximate due to minify +
    // placeholder replacement, but line mapping and original source display work.
    if let Some(map) = &module.map {
        let map_name = format!("{filename}.map");
        fs::write(out_dir.join(&map_name), map)?;
        code.push_str(&format!("\n//# sourceMappingURL={map_name}\n"));
    }

    fs::write(out_dir.join(&filename), &code)?;
    ctx.deps.insert(filename.clone(), dep_names);
    ctx.emitted.insert(abs.to_path_buf(), filename.clone());
    Ok(filename)
}

/// Scope-hoists an island into one chunk. Concatenated: the island itself + concatenable
/// app modules used only by that island. External deps (node_modules/shared/css/asset) become
/// separate chunks via emit(), linked by ESM imports. Falls back to unbundled emit if concatenation fails.
fn emit_island(
    core: &NowakiCore,
    island: &Path,
    app_set: &HashSet<PathBuf>,
    app_count: &HashMap<PathBuf, usize>,
    out_dir: &Path,
    ctx: &mut EmitCtx,
) -> Result<String> {
    let mut internal: Vec<PathBuf> = vec![island.to_path_buf()];
    for m in app_set {
        if m == island {
            continue;
        }
        if app_count.get(m).copied().unwrap_or(0) == 1 && !crate::chunk::needs_fallback(core, m) {
            internal.push(m.clone());
        }
    }
    let internal_set: HashSet<&Path> = internal.iter().map(|p| p.as_path()).collect();

    let mut external_name: HashMap<PathBuf, String> = HashMap::new();
    for m in &internal {
        for dep in crate::chunk::module_deps(core, m)? {
            if !internal_set.contains(dep.as_path()) {
                let fname = emit(core, &dep, out_dir, ctx)?;
                external_name.insert(dep, fname);
            }
        }
    }

    let stem = island
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("island");
    match crate::chunk::hoist_chunk(core, island, &internal, &external_name) {
        Ok(source) => {
            let chunk_name = format!("{stem}.js");
            let (mut code, map) = crate::chunk::minify_chunk(&chunk_name, &source)?;
            let hash = xxh3_64(code.as_bytes()) as u32;
            let filename = format!("{stem}.{hash:08x}.js");
            if let Some(m) = map {
                let map_name = format!("{filename}.map");
                fs::write(out_dir.join(&map_name), m)?;
                code.push_str(&format!("\n//# sourceMappingURL={map_name}\n"));
            }
            fs::write(out_dir.join(&filename), &code)?;
            // Record direct deps only (render_manifest walks the transitive ones)
            ctx.deps
                .insert(filename.clone(), external_name.values().cloned().collect());
            ctx.emitted.insert(island.to_path_buf(), filename.clone());
            Ok(filename)
        }
        Err(_) => emit(core, island, out_dir, ctx),
    }
}

/// Returns a chunk's transitive deps (excluding itself, deduped). For preload chains.
fn transitive_deps(entry: &str, deps: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<String> = deps.get(entry).cloned().unwrap_or_default();
    while let Some(d) = stack.pop() {
        if !seen.insert(d.clone()) {
            continue;
        }
        if let Some(children) = deps.get(&d) {
            stack.extend(children.iter().cloned());
        }
        out.push(d);
    }
    out.sort();
    out
}

struct BundleModule {
    code: String,
    deps: Vec<DepRef>,
    /// External source map JSON (sourcesContent embedded).
    map: Option<String>,
}

struct DepRef {
    placeholder: String,
    abs_path: PathBuf,
}

/// TS type stripping + JSX (automatic, preact) + minify codegen.
/// Import specifiers are replaced with unique placeholders; resolved absolute paths go into deps.
/// (The caller later replaces placeholders with the deps' hashed names.)
fn transform_for_bundle(path: &Path, source: &str, core: &NowakiCore) -> Result<BundleModule> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::tsx());

    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.errors.is_empty() {
        let msgs: Vec<String> = parsed.errors.iter().map(|e| e.to_string()).collect();
        return Err(anyhow!(
            "parse error in {}: {}",
            path.display(),
            msgs.join("; ")
        ));
    }
    let mut program = parsed.program;

    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();
    let scoping = crate::transform::apply_client_defines(
        &allocator,
        scoping,
        &mut program,
        &core.client_defines,
    );

    let mut options = TransformOptions::default();
    options.jsx.runtime = JsxRuntime::Automatic;
    options.jsx.import_source = Some("preact".to_string());
    let ret =
        Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !ret.errors.is_empty() {
        let msgs: Vec<String> = ret.errors.iter().map(|e| e.to_string()).collect();
        return Err(anyhow!(
            "transform error in {}: {}",
            path.display(),
            msgs.join("; ")
        ));
    }

    // Tree shaking / DCE / mangle. Remove unused imports and dead code before
    // recording deps (removed imports don't enter deps).
    Minifier::new(MinifierOptions::default()).minify(&allocator, &mut program);

    let dir = path.parent().unwrap_or(&core.root);
    let mut deps = Vec::new();
    for stmt in program.body.iter_mut() {
        let source_lit = match stmt {
            Statement::ImportDeclaration(d) => Some(&mut d.source),
            Statement::ExportNamedDeclaration(d) => d.source.as_mut(),
            Statement::ExportAllDeclaration(d) => Some(&mut d.source),
            _ => None,
        };
        let Some(lit) = source_lit else { continue };
        if let Some(aliased) = crate::resolve::alias_specifier(lit.value.as_str()) {
            lit.value = allocator.alloc_str(aliased).into();
            lit.raw = None;
        }
        let spec = lit.value.as_str();
        if spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:") {
            continue;
        }
        let abs_path = core
            .resolve_spec(dir, spec)
            .ok_or_else(|| anyhow!("failed to resolve {spec} (from {})", dir.display()))?;
        let placeholder = format!("__NOWAKI_DEP_{}__", deps.len());
        lit.value = allocator.alloc_str(&placeholder).into();
        lit.raw = None;
        deps.push(DepRef {
            placeholder,
            abs_path,
        });
    }

    // Make sources root-relative; never expose absolute paths, including out-of-root deps (pnpm store).
    let rel = client_source_name(&core.root, path);
    let ret = Codegen::new()
        .with_options(CodegenOptions {
            minify: true,
            source_map_path: Some(rel),
            ..CodegenOptions::default()
        })
        .build(&program);
    let map = ret.map.map(|m| m.to_json_string());

    Ok(BundleModule {
        code: ret.code,
        deps,
        map,
    })
}

/// Whether it has `export const live`. Checked after read_source (.tsrx already compiled).
fn is_live_island(core: &NowakiCore, abs: &Path) -> bool {
    core.read_source(abs)
        .map(|s| s.contains("export const live"))
        .unwrap_or(false)
}

/// Generates manifest.json by hand (no serde, to avoid extra deps; file names are ascii only).
/// `preload`: each entry chunk → its transitive dep chunks. To avoid request waterfalls,
/// pages `<link rel=modulepreload>` the island chunk and all its deps at once.
fn render_manifest(
    runtime: Option<&str>,
    router_runtime: Option<&str>,
    islands: &[(String, String)],
    live_islands: &[String],
    live_runtime: Option<&str>,
    deps: &HashMap<String, Vec<String>>,
) -> String {
    let runtime_field = match runtime {
        Some(r) => format!("\"{r}\""),
        None => "null".to_string(),
    };
    // routerRuntime is a lazy chunk. Not in preload (keeps first-load minimal).
    let router_runtime_field = match router_runtime {
        Some(r) => format!("\"{r}\""),
        None => "null".to_string(),
    };
    let live_runtime_field = match live_runtime {
        Some(r) => format!("\"{r}\""),
        None => "null".to_string(),
    };
    let live_islands_field = live_islands
        .iter()
        .map(|n| format!("\"{n}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let island_fields: Vec<String> = islands
        .iter()
        .map(|(name, file)| format!("    \"{name}\": \"{file}\""))
        .collect();

    // Write the transitive deps of entry chunks (runtime + each island + lazy router) to preload.
    // Router deps are recorded too, but the HTML doesn't preload the router (it's lazy-loaded).
    // Benchmarks use this dep list to exclude "lazy chunks" from first-load.
    let mut entries: Vec<&str> = Vec::new();
    let mut seen = HashSet::new();
    if let Some(r) = runtime {
        if seen.insert(r) {
            entries.push(r);
        }
    }
    if let Some(r) = router_runtime {
        if seen.insert(r) {
            entries.push(r);
        }
    }
    for (_, file) in islands {
        if seen.insert(file.as_str()) {
            entries.push(file);
        }
    }
    let preload_fields: Vec<String> = entries
        .iter()
        .map(|entry| {
            let chain = transitive_deps(entry, deps);
            let arr: Vec<String> = chain.iter().map(|c| format!("\"{c}\"")).collect();
            format!("    \"{entry}\": [{}]", arr.join(", "))
        })
        .collect();

    format!(
        "{{\n  \"runtime\": {runtime_field},\n  \"routerRuntime\": {router_runtime_field},\n  \"liveRuntime\": {live_runtime_field},\n  \"liveIslands\": [{live_islands_field}],\n  \"islands\": {{\n{}\n  }},\n  \"preload\": {{\n{}\n  }}\n}}\n",
        island_fields.join(",\n"),
        preload_fields.join(",\n")
    )
}
