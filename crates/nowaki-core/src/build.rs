//! Production build.
//!
//! The client build walks the client module graph from its entries (the islands runtime, the
//! lazy SPA router, every island, the live runtime when there are live islands, and page
//! scripts), transforms and minifies each module, and writes content-hashed ESM, route CSS,
//! `manifest.json`, and precompressed siblings to `dist/client/`. Per island, app modules used
//! only by that island are concatenated into one scope (scope hoisting, `chunk.rs`); package,
//! shared, CSS, and asset modules become separate chunks, shared and deduped. Modules that can't
//! be concatenated fall back to unbundled emit.
//!
//! The server build transforms the app's server graph for SSR (not minified) into
//! `dist/server/`, with `functions.json` for server functions.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::{Expression, ImportExpression, Statement};
use oxc::ast_visit::{walk_mut, VisitMut};
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::minifier::{Minifier, MinifierOptions};
use xxhash_rust::xxh3::xxh3_64;

use crate::NowakiCore;

/// What `manifest.json` says, kept in memory for the route JS report (`budget.rs`).
#[derive(Debug, Default, Clone)]
pub struct ClientInfo {
    /// The islands runtime chunk, when `@nowaki-dev/runtime` is installed.
    pub runtime: Option<String>,
    /// Island name → chunk file.
    pub islands: HashMap<String, String>,
    /// Names of the live islands (they have no client chunk).
    pub live_islands: Vec<String>,
    /// The live runtime chunk, when there are live islands.
    pub live_runtime: Option<String>,
    /// Entry chunk (runtime or island) → the chunks it preloads.
    pub preload: HashMap<String, Vec<String>>,
}

/// What a build wrote, for the CLI's summary.
pub struct BuildReport {
    /// Client modules emitted (chunks, asset modules, style modules).
    pub modules: usize,
    /// Client islands (live islands excluded).
    pub islands: usize,
    /// Server modules written (0 until [`build_server`] runs).
    pub server_modules: usize,
    /// The client output directory (`dist/client`).
    pub out_dir: PathBuf,
    /// Total input bytes of the images the client build optimized or resized.
    pub asset_in: u64,
    /// Total output bytes of those images (for reporting savings).
    pub asset_out: u64,
}

/// Walks the graph from the client entries (islands runtime, SPA router, islands, live runtime,
/// page scripts), writes to dist/client/, and writes manifest.json.
/// Also returns an "asset absolute path → served URL" map (shared with the server build).
pub fn build_client(
    core: &NowakiCore,
    dist: &Path,
) -> Result<(BuildReport, HashMap<PathBuf, String>)> {
    let (report, assets, _) = build_client_with_info(core, dist)?;
    Ok((report, assets))
}

/// `build_client`, plus the manifest data in memory (for the route JS report).
pub fn build_client_with_info(
    core: &NowakiCore,
    dist: &Path,
) -> Result<(BuildReport, HashMap<PathBuf, String>, ClientInfo)> {
    let client_dir = dist.join("client");
    // Start empty so deleted islands/modules from a previous build don't ship.
    clear_dir(&client_dir)?;
    fs::create_dir_all(&client_dir)
        .with_context(|| format!("failed to create dist: {}", client_dir.display()))?;

    let mut ctx = EmitCtx::default();

    // The eager client runtime (islands.js: hydration only). Pages with client islands load it
    // (so do streaming pages and pages with an intercepting slot). The SPA router is a separate
    // chunk to keep the first load small.
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

    // Each component under islands/.
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
            let name = island_name(&p)?;
            if is_live_island(core, &p) {
                live_islands.push(name); // no client chunk
            } else {
                entries.push(p);
            }
        }

        // Each island's reachable app modules, and how many islands reach each module.
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
            let name = island_name(island)?;
            ctx.entry = Some(island.clone());
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

    // Page scripts (`export const scripts`) of each route and layout: client entries like islands.
    let route_scripts = build_route_scripts(core, &client_dir, &mut ctx)?;

    // Stylesheets for the CSS that routes and layouts import (route_css.rs).
    let route_css = crate::route_css::build_route_css(core, &client_dir)?;
    let mut manifest = render_manifest(
        runtime_out.as_deref(),
        router_runtime_out.as_deref(),
        &islands,
        &live_islands,
        live_runtime_out.as_deref(),
        &ctx.deps,
    );
    // `"routeCss": { "routes/x.js": ["site.1a2b3c4d.css"] }`; `"routeScripts"` the same per module
    // (route or layout; the runtime merges a page's layouts), and `"scriptPreload"`: each
    // script's transitive chunks.
    let script_files: BTreeSet<&String> = route_scripts.values().flatten().collect();
    let script_preload: serde_json::Map<String, serde_json::Value> = script_files
        .iter()
        .map(|f| {
            (
                (*f).clone(),
                serde_json::json!(transitive_deps(f, &ctx.deps)),
            )
        })
        .collect();
    manifest["routeCss"] = serde_json::json!(route_css);
    manifest["routeScripts"] = serde_json::json!(route_scripts);
    manifest["scriptPreload"] = serde_json::Value::Object(script_preload);
    let manifest = serde_json::to_string_pretty(&manifest)? + "\n";
    fs::write(client_dir.join("manifest.json"), manifest)?;
    // `.gz` / `.br` siblings: `nowaki start` serves them by Accept-Encoding, and most static hosts
    // pick them up too.
    crate::compress::precompress_dir(&client_dir)?;

    let client = ClientInfo {
        runtime: runtime_out.clone(),
        islands: islands.iter().cloned().collect(),
        live_islands: live_islands.clone(),
        live_runtime: live_runtime_out.clone(),
        // Same transitive lists the manifest's `preload` field holds.
        preload: runtime_out
            .iter()
            .chain(islands.iter().map(|(_, f)| f))
            .map(|f| (f.clone(), transitive_deps(f, &ctx.deps)))
            .collect(),
    };
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
        client,
    ))
}

/// Empties `dir`, keeping the directory itself. Windows can't remove a directory that is some
/// process's working directory (e.g. a server started from dist/server), but its files are fine.
pub fn clear_dir(dir: &Path) -> Result<()> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries {
        let path = entry?.path();
        let res = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        res.with_context(|| format!("failed to clear {}", path.display()))?;
    }
    Ok(())
}

/// `export const scripts` of every page route, layout, and 404 / 500 page under `routes/`, each
/// script emitted as a client entry. Keyed by server module (`routes/x.js`), in listed order.
fn build_route_scripts(
    core: &NowakiCore,
    client_dir: &Path,
    ctx: &mut EmitCtx,
) -> Result<BTreeMap<String, Vec<String>>> {
    let routes_dir = core.root.join("routes");
    let mut out = BTreeMap::new();
    if !routes_dir.is_dir() {
        return Ok(out);
    }
    for path in crate::routes::walk_routes_dir(&routes_dir)? {
        let Some(rel) = path
            .strip_prefix(&routes_dir)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
        else {
            continue;
        };
        if let Some(msg) = crate::routes::removed_convention(&rel) {
            anyhow::bail!(msg);
        }
        let Some(stem) = crate::routes::stem_from_rel(&rel) else {
            continue;
        };
        let base = stem.rsplit('/').next().unwrap_or(&stem);
        let page_like = base == "_layout" || base == "_404" || base == "_500";
        if crate::routes::is_endpoint_rel(&rel)
            || (crate::routes::is_convention_source(base) && !page_like)
        {
            continue;
        }
        let source = core.read_source(&path)?;
        let specs = crate::page_scripts::parse_scripts(&path, &source)
            .map_err(|e| anyhow::anyhow!("routes/{rel}: {e}"))?;
        if specs.is_empty() {
            continue;
        }
        let dir = path.parent().unwrap_or(&routes_dir);
        let mut files = Vec::new();
        for spec in specs {
            let Some(abs) = core.resolve_spec(dir, &spec) else {
                anyhow::bail!("routes/{rel}: page script \"{spec}\" not found");
            };
            ctx.entry = Some(abs.clone());
            let name = emit(core, &abs, client_dir, ctx)?;
            if !files.contains(&name) {
                files.push(name);
            }
        }
        out.insert(format!("routes/{stem}.js"), files);
    }
    Ok(out)
}

/// Server build: transforms the app's server graph (routes/, islands/, components/, lib/,
/// actions/, content/, env.ts, session.ts, and every app module they import) in SSR mode and
/// writes it to dist/server/ as ESM that Node can run directly. Relative imports of TS and other
/// compiled extensions become `.js`; bare imports are left to Node resolution. `assets` is the
/// client build's asset map. Returns the number of output modules.
pub fn build_server(
    core: &NowakiCore,
    dist: &Path,
    assets: &HashMap<PathBuf, String>,
) -> Result<usize> {
    use rayon::prelude::*;

    let server_dir = dist.join("server");
    clear_dir(&server_dir)?;
    let mut files = Vec::new();
    // `content` holds the collections' config.ts (its Markdown / JSON entries aren't modules).
    for sub in [
        "routes",
        "islands",
        "components",
        "lib",
        "actions",
        "content",
    ] {
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
    // env.ts at the app root: the server validates it at startup (dist/server/env.js).
    if let Some(env_file) = crate::env::env_file(&core.root) {
        files.push(env_file);
    }
    // session.ts at the app root: the session options the server loads (dist/server/session.js).
    if let Some(session_file) = ["session.ts", "session.mts", "session.js", "session.mjs"]
        .iter()
        .map(|f| core.root.join(f))
        .find(|p| p.is_file())
    {
        files.push(session_file);
    }
    // Plus every app module those import from anywhere else in the app (`data/`, `sections/`,
    // `utils/`, …): the conventional folders are entry points, not the whole server graph.
    // One walk over the whole graph: every module is parsed once, however many entries reach it.
    // JSON the server graph imports (`import site from "../data/site.json" with { type: "json" }`)
    // is loaded by Node as is, so it's copied next to the emitted modules.
    let mut json_files: HashSet<PathBuf> = HashSet::new();
    {
        let mut seen: HashSet<PathBuf> = files.iter().cloned().collect();
        let mut stack: Vec<PathBuf> = files.clone();
        while let Some(m) = stack.pop() {
            // The server graph, not the client one: it goes through `"use server"` modules (a
            // client boundary) and follows `export … from` and string-literal `import()` too.
            let Ok(imports) = crate::graph::module_imports(core, &m) else {
                continue; // the transform below reports it
            };
            for d in imports.into_iter().filter_map(|i| i.resolved) {
                if is_app_json(core, &d) {
                    json_files.insert(d.clone());
                }
                if crate::chunk::is_app_module(core, &d) && seen.insert(d.clone()) {
                    files.push(d.clone());
                    stack.push(d);
                }
            }
        }
    }

    let server_assets = ServerAssets {
        client_dir: dist.join("client"),
        asset_base: core.asset_base(),
        urls: Mutex::new(assets.clone()),
    };
    // Server modules are independent (no naming dependencies), so they are transformed in
    // parallel.
    let results: Vec<Result<(PathBuf, String)>> = files
        .par_iter()
        .map(|path| {
            let rel = path
                .strip_prefix(&core.root)
                .with_context(|| format!("failed to relativize: {}", path.display()))?;
            let out_path = server_dir.join(with_js_ext(rel));
            let source = core.read_source(path)?;
            let code = transform_for_server(path, &out_path, &source, core, &server_assets)?;
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
    for json in &json_files {
        let out_path = server_dir.join(json.strip_prefix(&core.root)?);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(json, &out_path).with_context(|| format!("failed to copy: {}", json.display()))?;
    }

    // Write the server function (`"use server"`) allowlist to dist/server/functions.json.
    // The runtime dispatches via this id→{module,export} (the client can't call arbitrary exports).
    // Kept out of the client manifest (so the server's file layout isn't exposed).
    write_server_functions(core, &server_dir)?;
    // With env.ts the server validates only its server variables at startup; the public ones are
    // the values this build inlined, so server and client agree.
    if crate::env::env_file(&core.root).is_some() {
        fs::write(
            server_dir.join("env-public.json"),
            crate::env::public_values_json(&core.client_defines),
        )?;
    }

    Ok(count)
}

/// A `.json` file of the app (under the root, outside node_modules).
fn is_app_json(core: &NowakiCore, abs: &Path) -> bool {
    abs.extension().is_some_and(|e| e == "json")
        && abs.starts_with(&core.root)
        && !abs.components().any(|c| c.as_os_str() == "node_modules")
}

/// Writes dist/server/functions.json: server function id → `module` (a `.js` path relative to
/// dist/server) and `export`.
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

/// Asset URLs for the server build: the client build's, plus assets that only server modules
/// import, which are emitted to dist/client on first use (rayon threads share this).
struct ServerAssets {
    client_dir: PathBuf,
    /// `NowakiCore::asset_base`.
    asset_base: String,
    urls: Mutex<HashMap<PathBuf, String>>,
}

impl ServerAssets {
    /// The `?image` module for `abs` (path with its query): the client build's when it emitted
    /// one (kept in the same map, as module code), else built now into dist/client.
    fn image_module(&self, abs: &Path, q: &crate::image::ImageQuery) -> Result<String> {
        if let Some(code) = self.urls.lock().unwrap().get(abs) {
            if code.starts_with("export default") {
                return Ok(code.clone());
            }
        }
        let (file, _) = crate::image::split_query(abs);
        let root = self
            .client_dir
            .parent()
            .and_then(Path::parent)
            .unwrap_or(Path::new("."));
        let set = crate::image::build_set(root, &file, q, |stem, w, ext, bytes| {
            crate::image::write_variant_at(
                &self.client_dir,
                &self.asset_base,
                &sanitize_name(stem),
                w,
                ext,
                bytes,
            )
        })?;
        let code = set.module();
        self.urls
            .lock()
            .unwrap()
            .insert(abs.to_path_buf(), code.clone());
        Ok(code)
    }

    /// The served URL of asset `abs`, emitting it into dist/client on first use.
    fn url_for(&self, abs: &Path) -> Result<String> {
        let mut urls = self.urls.lock().unwrap();
        if let Some(url) = urls.get(abs) {
            return Ok(url.clone());
        }
        let (name, _, _) = write_asset(abs, &self.client_dir)?;
        let url = format!("{}{name}", self.asset_base);
        urls.insert(abs.to_path_buf(), url.clone());
        Ok(url)
    }
}

/// SSR transform: TS stripping, JSX (automatic runtime, Preact), client defines, and import
/// rewrites (virtual modules, CSS, assets, `?image`, relative imports to `.js`). Not minified, so
/// the inline source map is exact and SSR stack traces stay readable.
fn transform_for_server(
    path: &Path,
    out_path: &Path,
    source: &str,
    core: &NowakiCore,
    assets: &ServerAssets,
) -> Result<String> {
    let allocator = Allocator::default();
    let mut program = crate::transform::parse_program(
        &allocator,
        path,
        source,
        crate::transform::source_type_for_path(path),
    )?;
    let scoping = crate::transform::semantic_scoping(&program);
    let scoping = crate::transform::apply_client_defines(
        &allocator,
        scoping,
        &mut program,
        &core.client_defines,
    );
    crate::transform::run_preact_transform(&allocator, path, source, scoping, &mut program)?;

    let dir = path.parent().unwrap_or(&core.root);
    for stmt in program.body.iter_mut() {
        let source_lit = match stmt {
            Statement::ImportDeclaration(d) => Some(&mut d.source),
            Statement::ExportFromDeclaration(d) => Some(&mut d.source),
            Statement::ExportAllDeclaration(d) => Some(&mut d.source),
            _ => None,
        };
        let Some(lit) = source_lit else { continue };
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
        // Inline virtual modules as `data:` URLs (assumed self-contained ESM).
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
                // `read_css` inlines `@import`s, as the client stylesheet does.
                if let Ok(css) = core.read_css(&full) {
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
        // Plain CSS: its text is the default export (the page links it as a stylesheet, from
        // routeCss). Package CSS (`pkg/style.css`) included.
        if spec.ends_with(".css") {
            let text = core
                .resolver
                .resolve(dir, spec)
                .ok()
                .and_then(|r| fs::read_to_string(r.full_path()).ok());
            let module = match text {
                Some(css) => crate::transform::data_module(&format!(
                    "export default {}",
                    crate::css::js_string(&css)
                )),
                None => crate::css::CSS_NOOP_SPECIFIER.to_string(),
            };
            lit.value = allocator.alloc_str(&module).into();
            lit.raw = None;
            continue;
        }
        // Assets: the hashed URL the client build emitted, or emit it now (server-only imports).
        // A remote `?image` resolves to its cached download.
        let remote = core
            .resolve_remote_image(spec)
            .transpose()
            .with_context(|| path.display().to_string())?;
        if remote.is_some()
            || (!spec.starts_with('/') && !spec.contains("://") && !spec.starts_with("data:"))
        {
            if let Some(full) =
                remote.or_else(|| core.resolver.resolve(dir, spec).ok().map(|r| r.full_path()))
            {
                // `./hero.jpg?image`: the image set module (see image.rs).
                let (file, query) = crate::image::split_query(&full);
                if let Some(q) = query.as_deref().and_then(crate::image::image_query) {
                    let code = assets.image_module(&full, &q)?;
                    let data = crate::transform::data_module(&code);
                    lit.value = allocator.alloc_str(&data).into();
                    lit.raw = None;
                    continue;
                }
                let full = if query.is_some() && crate::is_asset(&file) {
                    file
                } else {
                    full
                };
                if crate::is_asset(&full) {
                    let url = assets.url_for(&full)?;
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
    // `import("./x.ts")` must load the emitted `./x.js` too (build_server emits its target).
    DynamicImportSpecs {
        allocator: &allocator,
    }
    .visit_program(&mut program);

    // SSR isn't minified, so the inline source map is exact (for node --enable-source-maps).
    let ret = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(server_source_name(&core.root, path, out_path)),
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

/// Rewrites string-literal `import()` specifiers the way static imports are (React packages →
/// preact/compat, TS extension → .js).
struct DynamicImportSpecs<'a> {
    allocator: &'a Allocator,
}

impl<'a> VisitMut<'a> for DynamicImportSpecs<'a> {
    fn visit_import_expression(&mut self, it: &mut ImportExpression<'a>) {
        if let Expression::StringLiteral(lit) = &mut it.source {
            let rewritten = match lit.value.as_str() {
                Some(spec) => match crate::resolve::alias_specifier(spec) {
                    Some(aliased) => Some(aliased.to_string()),
                    None => rewrite_server_spec(spec),
                },
                None => None,
            };
            if let Some(rewritten) = rewritten {
                lit.value = self.allocator.alloc_str(&rewritten).into();
                lit.raw = None;
            }
        }
        walk_mut::walk_import_expression(self, it);
    }
}

/// Rewrites TS extensions (and `.mjs`, also emitted as `.js`) in relative local imports to .js.
/// Leaves bare/absolute/.js alone.
fn rewrite_server_spec(spec: &str) -> Option<String> {
    if !spec.starts_with('.') {
        return None;
    }
    if spec.ends_with(".css") {
        // Reached only by `import()`: static CSS imports are handled in `transform_for_server`.
        return Some(crate::css::CSS_NOOP_SPECIFIER.to_string());
    }
    for ext in [".tsx", ".jsx", ".ts", ".tsrx", ".mdx", ".mdoc", ".mjs"] {
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
    /// Modules currently on the DFS stack (for cycle detection).
    visiting: HashSet<PathBuf>,
    /// Asset path → served URL (for `?image`, the module code), shared with the server build.
    assets: HashMap<PathBuf, String>,
    /// Provisional pre-rewrite file names used for cycles.
    provisional: HashMap<PathBuf, String>,
    /// Modules found to be part of a cycle (their provisional name becomes final).
    cyclic: HashSet<PathBuf>,
    /// Output file name → output file names of direct deps (for computing preload chains).
    deps: HashMap<String, Vec<String>>,
    asset_in: u64,
    asset_out: u64,
    /// The client entry being emitted (island or page script), for import-chain errors.
    entry: Option<PathBuf>,
}

/// `sources` entry of a server module's inline map: the source relative to the emitted file's
/// directory (`../../../../routes/(account)/_middleware.ts` for
/// `dist/server/routes/(account)/_middleware.js`), which is how Node's `--enable-source-maps`
/// resolves it, so stack traces name the real file. Relative, so no absolute path is embedded.
fn server_source_name(root: &Path, path: &Path, out_path: &Path) -> PathBuf {
    let from: Vec<_> = out_path.parent().unwrap_or(out_path).components().collect();
    let to: Vec<_> = path.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return client_source_name(root, path);
    }
    let mut parts: Vec<String> = vec!["..".to_string(); from.len() - common];
    parts.extend(
        to[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    // `/` on every platform: a source map URL, not a native path.
    PathBuf::from(parts.join("/"))
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
/// Acyclic modules are named by the hash of their final content (correct for immutable
/// caching). Cycles fall back to a provisional name from the pre-rewrite hash (still post-order
/// DFS).
fn emit(core: &NowakiCore, abs: &Path, out_dir: &Path, ctx: &mut EmitCtx) -> Result<String> {
    if let Some(name) = ctx.emitted.get(abs) {
        return Ok(name.clone());
    }
    if crate::env::is_server_env_module(abs) {
        let from = ctx.entry.clone().unwrap_or_else(|| abs.to_path_buf());
        let chain = client_import_chain(core, &from, abs);
        anyhow::bail!(crate::env::server_env_import_error(&core.root, &chain));
    }
    // `./hero.jpg?image`: AVIF + fallback variants and a module exporting the set (image.rs).
    let (file, query) = crate::image::split_query(abs);
    if let Some(q) = query.as_deref().and_then(crate::image::image_query) {
        let set = crate::image::build_set(&core.root, &file, &q, |stem, w, ext, bytes| {
            ctx.asset_out += bytes.len() as u64;
            crate::image::write_variant_at(
                out_dir,
                &core.asset_base(),
                &sanitize_name(stem),
                w,
                ext,
                bytes,
            )
        })?;
        ctx.asset_in += fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        let code = set.module();
        let stem = output_stem(&file, "image");
        let mod_name = format!("{stem}.image.{:08x}.js", xxh3_64(code.as_bytes()) as u32);
        fs::write(out_dir.join(&mod_name), &code)?;
        ctx.assets.insert(abs.to_path_buf(), code);
        ctx.deps.insert(mod_name.clone(), Vec::new());
        ctx.emitted.insert(abs.to_path_buf(), mod_name.clone());
        return Ok(mod_name);
    }
    // Any other query on an asset (`?url`, a cache-buster): the file itself.
    if query.is_some() && crate::is_asset(&file) {
        return emit(core, &file, out_dir, ctx);
    }
    // Assets (images, fonts, etc.): copy raw with a content hash and
    // emit a tiny JS module that default-exports the served URL (no deps).
    if crate::is_asset(abs) {
        let (asset_name, size_in, size_out) = write_asset(abs, out_dir)?;
        ctx.asset_in += size_in;
        ctx.asset_out += size_out;
        let stem = output_stem(abs, "asset");
        let out_ext = asset_name.rsplit('.').next().unwrap_or("bin");
        let url = format!("{}{asset_name}", core.asset_base());
        ctx.assets.insert(abs.to_path_buf(), url.clone());
        let code = format!("export default \"{url}\";\n");
        let mod_hash = xxh3_64(code.as_bytes()) as u32;
        let mod_name = format!("{stem}.{out_ext}.{mod_hash:08x}.js");
        fs::write(out_dir.join(&mod_name), &code)?;
        ctx.deps.insert(mod_name.clone(), Vec::new());
        ctx.emitted.insert(abs.to_path_buf(), mod_name.clone());
        return Ok(mod_name);
    }
    // .css becomes a <style>-injecting JS shim; *.module.css is scoped and exports a class name
    // map (no deps).
    if crate::css::is_css(abs) {
        let css = core.read_css(abs)?;
        let id = crate::css::css_scope_id(&core.root, abs);
        let code = if crate::css::is_css_module(abs) {
            let (scoped, map) = crate::css::scope_css(&id, &css);
            crate::css::css_module_client_js(&id, &scoped, &map)
        } else {
            crate::css::css_shim(&id, &css)
        };
        let hash = xxh3_64(code.as_bytes()) as u32;
        let stem = output_stem(abs, "style");
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
        let code = crate::server_fn::client_proxy_at(&key, &exports, &core.server_fn_path());
        let stem = output_stem(abs, "module");
        let hash = xxh3_64(code.as_bytes()) as u32;
        let filename = format!("{stem}.{hash:08x}.js");
        fs::write(out_dir.join(&filename), &code)?;
        ctx.deps.insert(filename.clone(), Vec::new());
        ctx.emitted.insert(abs.to_path_buf(), filename.clone());
        return Ok(filename);
    }
    let module = transform_for_bundle(abs, &source, core)?;
    let stem = output_stem(abs, "module");

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

/// The client import path from `from` to `target` (both included), found again only for an error
/// message. Stops at `"use server"` modules, which the client gets as proxies.
fn client_import_chain(core: &NowakiCore, from: &Path, target: &Path) -> Vec<PathBuf> {
    let mut parent: HashMap<PathBuf, PathBuf> = HashMap::new();
    let mut queue = std::collections::VecDeque::from([from.to_path_buf()]);
    let mut seen: HashSet<PathBuf> = HashSet::from([from.to_path_buf()]);
    while let Some(m) = queue.pop_front() {
        if m == target {
            let mut chain = vec![m.clone()];
            let mut cur = m;
            while let Some(p) = parent.get(&cur) {
                chain.push(p.clone());
                cur = p.clone();
            }
            chain.reverse();
            return chain;
        }
        let use_server = core
            .read_source(&m)
            .is_ok_and(|s| crate::server_fn::has_use_server(&s));
        if use_server || !crate::is_transformable(&m) {
            continue;
        }
        for d in crate::chunk::module_deps(core, &m).unwrap_or_default() {
            if seen.insert(d.clone()) {
                parent.insert(d.clone(), m.clone());
                queue.push_back(d);
            }
        }
    }
    vec![from.to_path_buf(), target.to_path_buf()]
}

/// Scope-hoists an island into one chunk: the island itself and the concatenable app modules
/// used only by that island. External deps (packages, shared app modules, CSS, assets) become
/// separate chunks through `emit`, linked by ESM imports. Falls back to unbundled emit if
/// concatenation fails.
fn emit_island(
    core: &NowakiCore,
    island: &Path,
    app_set: &HashSet<PathBuf>,
    app_count: &HashMap<PathBuf, usize>,
    out_dir: &Path,
    ctx: &mut EmitCtx,
) -> Result<String> {
    // Hoisting would drop what it can't concatenate (e.g. `import * as`), so such islands stay
    // unbundled.
    if crate::chunk::needs_fallback(core, island) {
        return emit(core, island, out_dir, ctx);
    }
    let mut others: Vec<PathBuf> = Vec::new();
    for m in app_set {
        if m == island {
            continue;
        }
        if app_count.get(m).copied().unwrap_or(0) == 1 && !crate::chunk::needs_fallback(core, m) {
            others.push(m.clone());
        }
    }
    // Each module's index becomes its rename suffix, so the order must not depend on HashSet
    // iteration: otherwise the chunk's names, bytes and hash change from one build to the next.
    others.sort();
    let mut internal: Vec<PathBuf> = vec![island.to_path_buf()];
    internal.extend(others);
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

    let stem = output_stem(island, "island");
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
            // Record direct deps only (render_manifest walks the transitive ones).
            let mut deps: Vec<String> = external_name.values().cloned().collect();
            deps.sort();
            ctx.deps.insert(filename.clone(), deps);
            ctx.emitted.insert(island.to_path_buf(), filename.clone());
            Ok(filename)
        }
        Err(_) => emit(core, island, out_dir, ctx),
    }
}

/// The island name of `path` under islands/: its file stem. The name goes into the page as
/// `<nowaki-island name="…">` (HTML-escaped) and the renderer reads it back from the markup to find
/// the island in manifest.json, so a character HTML escapes (`"`, `&`, `<`) would not
/// match, and `\` is a path separator on Windows. Such names are an error rather than an island
/// that silently loses its preload.
fn island_name(path: &Path) -> Result<String> {
    let name = path.file_stem().and_then(|s| s.to_str()).ok_or_else(|| {
        anyhow!(
            "island file name is not valid UTF-8: {}. Rename the file.",
            path.display()
        )
    })?;
    if let Some(c) = name
        .chars()
        .find(|c| matches!(c, '"' | '&' | '<' | '\\') || c.is_control())
    {
        return Err(anyhow!(
            "island file name {:?} contains {c:?}, which an island name can't: islands/{} (rename it; letters, digits, `_`, `-` and `.` are safe)",
            name,
            path.file_name().map(|f| f.to_string_lossy()).unwrap_or_default()
        ));
    }
    Ok(name.to_string())
}

/// The file stem of `path` as an output name part (see [`sanitize_name`]); `fallback` when it has
/// none.
fn output_stem(path: &Path, fallback: &str) -> String {
    match path.file_stem() {
        Some(s) => sanitize_name(&s.to_string_lossy()),
        None => fallback.to_string(),
    }
}

/// Makes a source-derived name part safe for dist/client: every character outside
/// `[A-Za-z0-9._-]` becomes `_`, and a leading `.` too. `nowaki start` (start.rs `asset_name`)
/// serves only such names, and the adapters and static output copy dist/client as is, so a
/// name like `logo@2x` is changed here rather than allowed there.
pub fn sanitize_name(stem: &str) -> String {
    let mut out: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.starts_with('.') {
        out.replace_range(..1, "_");
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Optimizes an asset and writes it under a content-hashed name. Returns (name, bytes in, bytes
/// out).
fn write_asset(abs: &Path, out_dir: &Path) -> Result<(String, u64, u64)> {
    let raw = fs::read(abs).with_context(|| format!("failed to read: {}", abs.display()))?;
    let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let stem = output_stem(abs, "asset");
    let (bytes, out_ext) = crate::asset::optimize(&raw, ext);
    let hash = xxh3_64(&bytes) as u32;
    let name = format!("{stem}.{hash:08x}.{out_ext}");
    fs::create_dir_all(out_dir)?;
    fs::write(out_dir.join(&name), &bytes)?;
    Ok((name, raw.len() as u64, bytes.len() as u64))
}

/// A chunk's transitive deps (excluding itself, deduped, sorted), for preload chains.
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

/// A client module after `transform_for_bundle`, before its deps are named.
struct BundleModule {
    code: String,
    deps: Vec<DepRef>,
    /// External source map JSON (sourcesContent embedded).
    map: Option<String>,
}

/// An import whose specifier was replaced by `placeholder`.
struct DepRef {
    placeholder: String,
    abs_path: PathBuf,
}

/// TS type stripping, JSX (automatic runtime, Preact), client defines, and minified codegen.
/// Import specifiers are replaced with unique placeholders and the resolved absolute paths go into
/// `deps`; the caller later replaces the placeholders with the deps' hashed names.
fn transform_for_bundle(path: &Path, source: &str, core: &NowakiCore) -> Result<BundleModule> {
    let allocator = Allocator::default();
    let mut program = crate::transform::parse_program(
        &allocator,
        path,
        source,
        crate::transform::source_type_for_path(path),
    )?;
    let scoping = crate::transform::semantic_scoping(&program);
    let scoping = crate::transform::apply_client_defines(
        &allocator,
        scoping,
        &mut program,
        &core.client_defines,
    );
    crate::transform::run_preact_transform(&allocator, path, source, scoping, &mut program)?;

    // Tree shaking / DCE / mangle. Remove unused imports and dead code before
    // recording deps (removed imports don't enter deps).
    let minified = Minifier::new(MinifierOptions::default()).minify(&allocator, &mut program);

    let dir = path.parent().unwrap_or(&core.root);
    let mut deps = Vec::new();
    for stmt in program.body.iter_mut() {
        let source_lit = match stmt {
            Statement::ImportDeclaration(d) => Some(&mut d.source),
            Statement::ExportFromDeclaration(d) => Some(&mut d.source),
            Statement::ExportAllDeclaration(d) => Some(&mut d.source),
            _ => None,
        };
        let Some(lit) = source_lit else { continue };
        // A specifier with a lone surrogate can't name a file or package.
        let Some(mut spec) = lit.value.as_str() else {
            return Err(anyhow!(
                "failed to resolve {} (from {})",
                lit.value.display(),
                dir.display()
            ));
        };
        if let Some(aliased) = crate::resolve::alias_specifier(spec) {
            lit.value = allocator.alloc_str(aliased).into();
            lit.raw = None;
            spec = aliased;
        }
        let remote = core
            .resolve_remote_image(spec)
            .transpose()
            .with_context(|| path.display().to_string())?;
        if remote.is_none()
            && (spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:"))
        {
            continue;
        }
        let abs_path = remote
            .or_else(|| crate::resolve::client_runtime_alias(&core.root, spec))
            .or_else(|| core.resolve_spec(dir, spec))
            .ok_or_else(|| anyhow!("failed to resolve {spec} (from {})", dir.display()))?;
        let placeholder = format!("__NOWAKI_DEP_{}__", deps.len());
        lit.value = allocator.alloc_str(&placeholder).into();
        lit.raw = None;
        deps.push(DepRef {
            placeholder,
            abs_path,
        });
    }

    // Make sources root-relative; never expose absolute paths, including out-of-root deps (pnpm
    // store).
    let rel = client_source_name(&core.root, path);
    // Only import sources were rewritten since minifying, so the scoping still matches.
    let ret = Codegen::new()
        .with_options(crate::chunk::client_codegen_options(rel))
        .with_scoping(minified.scoping)
        .build(&program);
    let map = ret.map.map(|m| m.to_json_string());

    Ok(BundleModule {
        code: ret.code,
        deps,
        map,
    })
}

/// Whether the island exports `live` (read from the AST after `read_source`, so `.tsrx` is
/// already compiled).
fn is_live_island(core: &NowakiCore, abs: &Path) -> bool {
    core.read_source(abs)
        .map(|s| crate::live_hint::exports_live(abs, &s))
        .unwrap_or(false)
}

/// Generates the first fields of manifest.json as text (the caller appends `routeCss`,
/// `routeScripts`, and `scriptPreload`). Chunk file names are sanitized ASCII; island names are
/// written unescaped. `preload`: each entry chunk → its transitive dep chunks. To avoid request
/// waterfalls, pages `<link rel=modulepreload>` the island chunk and all its deps at once.
fn render_manifest(
    runtime: Option<&str>,
    router_runtime: Option<&str>,
    islands: &[(String, String)],
    live_islands: &[String],
    live_runtime: Option<&str>,
    deps: &HashMap<String, Vec<String>>,
) -> serde_json::Value {
    use serde_json::{json, Map, Value};
    // Write the transitive deps of entry chunks (runtime + each island + lazy router) to preload.
    // routerRuntime is a lazy chunk: its deps are recorded, but the HTML doesn't preload it.
    // Benchmarks use this dep list to exclude lazy chunks from the first load.
    let mut preload = Map::new();
    let entries = runtime
        .into_iter()
        .chain(router_runtime)
        .chain(islands.iter().map(|(_, file)| file.as_str()));
    for entry in entries {
        if !preload.contains_key(entry) {
            preload.insert(entry.to_string(), json!(transitive_deps(entry, deps)));
        }
    }
    let islands: Map<String, Value> = islands
        .iter()
        .map(|(name, file)| (name.clone(), json!(file)))
        .collect();
    json!({
        "runtime": runtime,
        "routerRuntime": router_runtime,
        "liveRuntime": live_runtime,
        "liveIslands": live_islands,
        "islands": islands,
        "preload": preload,
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn server_source_names_resolve_from_the_emitted_file() {
        let root = Path::new("/app");
        let name = |src: &str, out: &str| {
            super::server_source_name(root, Path::new(src), Path::new(out))
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(
            name(
                "/app/routes/(account)/_middleware.ts",
                "/app/dist/server/routes/(account)/_middleware.js"
            ),
            "../../../../routes/(account)/_middleware.ts"
        );
        assert_eq!(
            name("/app/env.ts", "/app/dist/server/env.js"),
            "../../env.ts"
        );
        assert_eq!(
            name("/app/lib/db.ts", "/elsewhere/server/lib/db.js"),
            "../../../app/lib/db.ts"
        );
    }

    #[test]
    fn manifest_is_json_whatever_the_island_names() {
        let deps = std::collections::HashMap::from([(
            "it's.1.js".to_string(),
            vec!["chunk-\"q\".js".to_string()],
        )]);
        let m = super::render_manifest(
            Some("islands.1.js"),
            None,
            &[("it's>ü".to_string(), "it's.1.js".to_string())],
            &["Live'One".to_string()],
            None,
            &deps,
        );
        let text = serde_json::to_string_pretty(&m).unwrap();
        let back: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back["islands"]["it's>ü"], "it's.1.js");
        assert_eq!(back["liveIslands"][0], "Live'One");
        assert_eq!(back["preload"]["it's.1.js"][0], "chunk-\"q\".js");
        assert_eq!(back["routerRuntime"], serde_json::Value::Null);
    }

    #[test]
    fn island_names_that_cannot_round_trip_are_rejected() {
        assert_eq!(
            super::island_name(Path::new("/app/islands/Counter.tsx")).unwrap(),
            "Counter"
        );
        assert_eq!(
            super::island_name(Path::new("/app/islands/it's-ü.tsx")).unwrap(),
            "it's-ü"
        );
        // `\` is a path separator on Windows, so a file can't have it in its name there.
        let backslash: &[&str] = if cfg!(windows) { &[] } else { &["a\\b.tsx"] };
        for bad in ["Say\"Hi\".tsx", "a&b.tsx", "a<b.tsx", "a\nb.tsx"]
            .iter()
            .chain(backslash)
        {
            let err = super::island_name(&Path::new("/app/islands").join(bad))
                .unwrap_err()
                .to_string();
            assert!(err.contains("which an island name can't"), "{bad}: {err}");
        }
    }
}
