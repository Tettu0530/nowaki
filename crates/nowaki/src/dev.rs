use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use notify::{EventKind, RecursiveMode, Watcher};
use nowaki_core::{is_transformable, Mode, NowakiCore, VIRTUAL_DIR};
use serde_json::json;
use tokio::sync::broadcast;

use crate::sidecar;

pub struct DevState {
    pub(crate) core: NowakiCore,
    hmr_tx: broadcast::Sender<String>,
    pub(crate) ssr_version: AtomicU64,
    pub(crate) sidecar_port: u16,
    pub(crate) http: reqwest::Client,
    pub(crate) live_hub: Arc<crate::live::LiveHub>,
    /// Recent build / SSR / live / HMR errors for the MCP `recent_errors` tool.
    pub(crate) errors: Arc<crate::mcp::ErrorLog>,
    pub(crate) port: u16,
    pub(crate) plugins: bool,
    /// Roots /@fs/ may serve from (canonical paths). Anything else is rejected.
    fs_allow: Vec<PathBuf>,
    /// Whether --host exposes all interfaces. Used for WS Origin/Host checks.
    pub(crate) expose: bool,
    /// nowaki.config routing from `.nowaki/routing.json` (read at startup; a change needs a restart,
    /// which `apply_changes` says).
    front: Option<Arc<crate::front::Front>>,
    /// What `apply_changes` needs between batches: import edges and CSS Module class maps.
    hmr_graph: std::sync::Mutex<HmrGraph>,
}

impl DevState {
    /// Remembers the class map of a CSS Module the browser got, so a later edit can tell a rule
    /// change (`css`) from a class name change (the importers re-import).
    fn record_css_map(&self, abs: &Path, map: &[(String, String)]) {
        let mut graph = self.hmr_graph.lock().unwrap_or_else(|e| e.into_inner());
        graph
            .css_maps
            .insert(abs.to_path_buf(), nowaki_core::css::mapping_object(map));
    }
}

pub async fn run(root: PathBuf, port: u16, expose: bool, open: bool) -> Result<()> {
    let started = Instant::now();

    // The plugin host imports nowaki.config (plugins, and the build-time config site-config.mjs
    // normalizes) while typegen runs and the sidecar starts; it's waited for before serving:
    // routing (.nowaki/routing.json) must be in place for the first request.
    let plugin_host = crate::plugins::spawn(&root, true)?;
    // env.ts is checked in Node while the sidecar and plugin host start.
    let env_check = crate::env_schema::start(&root)?;
    crate::typegen::write(&root).ok();

    let live_hub = crate::live::LiveHub::new();
    let errors = crate::mcp::ErrorLog::new(&root);
    let sidecar = sidecar::spawn(&root, port, live_hub.clone(), errors.clone()).await?;

    let (plugin_host, config) = plugin_host.finish()?;
    let mut core = NowakiCore::new(root.clone());
    // Fast Refresh for island modules (browser transforms of app files only).
    core.set_dev_refresh(true);
    if let Some(ph) = &plugin_host {
        core.set_plugins(ph.bridge.clone());
    }
    // env.ts: validated at startup (a change to it or to .env needs a restart); its public values
    // are what the browser modules inline.
    crate::env_schema::finish(env_check, &mut core)?;

    // An invalid config is reported (site-config.mjs printed why) and dev runs without it.
    let config = config.unwrap_or_else(|e| {
        eprintln!("[nowaki] {e:#}");
        serde_json::Value::Object(Default::default())
    });
    if let Err(e) = crate::site::write_dev(&root, &config) {
        eprintln!("[nowaki] {e:#}");
    }
    let front = crate::front::load(&root.join(".nowaki/routing.json")).unwrap_or_else(|e| {
        eprintln!("[nowaki] {e:#}");
        None
    });
    if let Err(e) = crate::remote_images::configure(&mut core, &root, &config) {
        eprintln!("[nowaki] {e:#}");
    }
    if let Err(e) = crate::site::configure(&mut core, &config) {
        eprintln!("[nowaki] {e:#}");
    }
    // Fonts build in the background: startup doesn't wait on a download, and the renderer picks
    // up .nowaki/fonts.json once it exists.
    {
        let root = root.clone();
        std::thread::spawn(move || crate::fonts::build_dev(&root, &config));
    }

    let (hmr_tx, _) = broadcast::channel(64);
    let state = Arc::new(DevState {
        core,
        hmr_tx: hmr_tx.clone(),
        ssr_version: AtomicU64::new(1),
        sidecar_port: sidecar.port,
        // Pass redirects (302 etc.) through to the browser (don't follow server-side).
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build reqwest client"),
        live_hub,
        errors,
        port,
        plugins: plugin_host.is_some(),
        fs_allow: compute_fs_allow(&root),
        expose,
        front: front.clone(),
        hmr_graph: Default::default(),
    });

    dev_content(&state);
    let _watcher = start_watcher(&root, state.clone())?;

    let base = front.clone().filter(|f| f.has_base());
    let mut app = Router::new()
        .route("/__nowaki/hmr", get(hmr_ws))
        .route("/__nowaki/live", get(live_ws))
        .route("/__nowaki/server-functions", get(server_functions))
        .route("/__nowaki/ssr-module", get(ssr_module))
        .route("/__nowaki/route-css", get(route_css))
        .route("/__nowaki/css", get(dev_css))
        .route("/__nowaki/image", get(dev_image))
        .route("/__nowaki/fonts/{file}", get(dev_font))
        .route("/@fs/{*path}", get(serve_fs))
        .route(crate::mcp::PATH, axum::routing::any(crate::mcp::handle))
        .route(crate::mcp::DEVTOOLS_PATH, get(crate::mcp::devtools))
        .fallback(serve_or_proxy)
        .with_state(state);
    if let Some(front) = front.filter(|f| f.has_response_layer()) {
        app = app.layer(axum::middleware::from_fn_with_state(
            front,
            crate::front::headers_layer,
        ));
    }
    let app = app
        .layer(axum::middleware::from_fn_with_state(expose, host_guard))
        .layer(axum::middleware::from_fn(crate::csp::layer))
        .layer(axum::middleware::map_response(crate::security_headers::add));

    let bind_host = if expose { "0.0.0.0" } else { "127.0.0.1" };
    let listener = tokio::net::TcpListener::bind((bind_host, port)).await?;

    let mut features: Vec<&str> = Vec::new();
    if plugin_host.is_some() {
        features.push("plugins");
    }
    crate::ui::server_banner(
        "Nowaki",
        env!("CARGO_PKG_VERSION"),
        port,
        started.elapsed().as_millis(),
        &features,
        expose,
        Some(&crate::mcp::url(port)),
    );

    if open {
        crate::ui::open_browser(&format!("http://localhost:{port}/"));
    }

    // Don't wait for open HMR/live sockets on shutdown; just stop serving and drop the children.
    tokio::select! {
        r = serve(listener, app, base) => r?,
        _ = crate::shutdown::signal() => {}
    }
    drop(plugin_host);
    drop(sidecar);
    Ok(())
}

/// Serves `app` with the peer address (the MCP endpoint checks it), behind the basePath layer when
/// there is a basePath: the client reaches `/__nowaki/*` under the base, dev module URLs stay at
/// the root.
async fn serve(
    listener: tokio::net::TcpListener,
    app: Router,
    base: Option<Arc<crate::front::Front>>,
) -> std::io::Result<()> {
    use axum::ServiceExt;
    use tower_layer::Layer;
    type Peer = std::net::SocketAddr;
    match base {
        None => axum::serve(listener, app.into_make_service_with_connect_info::<Peer>()).await,
        Some(front) => {
            let app =
                axum::middleware::from_fn_with_state(front, crate::front::base_layer).layer(app);
            let app = ServiceExt::<Request>::into_make_service_with_connect_info::<Peer>(app);
            axum::serve(listener, app).await
        }
    }
}

/// Content collections in dev: re-read content/ into .nowaki/content/index.json, which the
/// sidecar loads for the next SSR version. A bad file is reported (overlay, MCP) and the last
/// good output is kept.
fn dev_content(state: &DevState) {
    let root = &state.core.root;
    if !crate::content::enabled(root) {
        return;
    }
    crate::typegen::write(root).ok();
    // i18n locales from the routing config `run` wrote before the first call.
    let routing = std::fs::read_to_string(root.join(".nowaki/routing.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Err(e) = crate::content::write(
        root,
        &root.join(".nowaki/content"),
        &crate::content::Images::Dev,
        &crate::content::locales(routing.as_ref()),
    ) {
        let msg = format!("{e:#}");
        eprintln!("[nowaki] content: {msg}");
        state.errors.record("build", &msg, None, None, None);
    }
}

/// How long a batch of file events has to be quiet before it is applied. An editor's save
/// (write, rename, metadata) lands within a few ms; the HMR budget is 100 ms edit to DOM.
const HMR_QUIET: Duration = Duration::from_millis(30);

fn start_watcher(root: &Path, state: Arc<DevState>) -> Result<notify::RecommendedWatcher> {
    let root_owned = root.to_path_buf();
    // notify's callback only filters and forwards; a worker thread batches the changes and
    // applies them once they have been quiet for HMR_QUIET. One save (several events) is one
    // update, a second quick save is never dropped, and nothing blocks notify's thread.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<PathBuf>>();
    let filter_state = state.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let event = match res {
            Ok(event) => event,
            Err(e) => {
                filter_state
                    .errors
                    .record("hmr", &e.to_string(), None, None, None);
                return;
            }
        };
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let relevant: Vec<PathBuf> = event
            .paths
            .into_iter()
            .filter(|p| {
                !under(
                    &filter_state.core.root,
                    p,
                    &["node_modules", ".git", "dist", "target", ".nowaki"],
                )
            })
            .collect();
        if !relevant.is_empty() {
            let _ = tx.send(relevant);
        }
    })?;
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch: std::collections::BTreeSet<PathBuf> = first.into_iter().collect();
            while let Ok(more) = rx.recv_timeout(HMR_QUIET) {
                batch.extend(more);
            }
            apply_changes(&state, batch.into_iter().collect());
        }
    });
    watcher.watch(&root_owned, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// Whether `p` is inside a directory named one of `names` (by path component, so Windows `\`
/// paths match too; "/x/" substring checks never did there).
fn under(root: &Path, p: &Path, names: &[&str]) -> bool {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .any(|c| names.iter().any(|n| c.as_os_str() == *n))
}

/// App-root files `nowaki dev` reads only at startup: nowaki.config (plugins, routing, site),
/// env.ts (checked, public values inlined into browser modules) and the .env files the sidecar
/// loads. (session.ts is re-imported for each SSR version.)
const STARTUP_FILES: &[&str] = &[
    "nowaki.config.mjs",
    "nowaki.config.js",
    "env.ts",
    "env.mts",
    "env.js",
    "env.mjs",
    ".env",
    ".env.local",
];

/// The changed files in `paths` that only take effect after a restart, as root-relative names.
fn needs_restart(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = paths
        .iter()
        .filter(|p| p.parent() == Some(root))
        .filter_map(|p| p.file_name()?.to_str())
        .filter(|n| STARTUP_FILES.contains(n))
        .map(str::to_string)
        .collect();
    out.dedup();
    out
}

fn apply_changes(state: &DevState, relevant: Vec<PathBuf>) {
    let root = &state.core.root;
    let restart = needs_restart(root, &relevant);
    if !restart.is_empty() {
        let (files, it) = (
            restart.join(", "),
            if restart.len() == 1 { "it" } else { "them" },
        );
        eprintln!("[nowaki] {files} changed; restart nowaki dev to apply {it}");
    }
    if relevant.iter().any(|p| under(root, p, &["routes"])) {
        crate::typegen::write(root).ok();
    }
    let under_content = relevant.iter().any(|p| {
        p.strip_prefix(root)
            .ok()
            .and_then(|r| r.components().next())
            .is_some_and(|c| c.as_os_str() == "content")
    });
    if under_content {
        dev_content(state);
    }
    state.ssr_version.fetch_add(1, Ordering::SeqCst);
    let files: Vec<String> = relevant.iter().map(|p| rel_name(root, p)).collect();
    let plan = {
        let mut graph = state.hmr_graph.lock().unwrap_or_else(|e| e.into_inner());
        plan_changes(&state.core, &mut graph, &relevant, !restart.is_empty())
    };
    let messages = hmr_messages(&state.core, &plan);
    for (kind, msg) in messages {
        crate::ui::hmr_log(kind, &files);
        let _ = state.hmr_tx.send(msg.to_string());
    }
}

/// A root-relative name for logs and messages (`/` separators).
fn rel_name(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Import edges and CSS Module class maps, kept across change batches.
#[derive(Default)]
pub(crate) struct HmrGraph {
    /// Each app module's resolved imports, with the (mtime, length) they were read at.
    imports: std::collections::HashMap<PathBuf, (Option<std::time::SystemTime>, u64, Vec<PathBuf>)>,
    /// The class map each CSS Module had when the browser last got it (`mapping_object` text).
    css_maps: std::collections::HashMap<PathBuf, String>,
}

impl HmrGraph {
    /// Who imports whom, for every app module (read again only when a file changed).
    fn importers(&mut self, core: &NowakiCore) -> std::collections::HashMap<PathBuf, Vec<PathBuf>> {
        let sources = nowaki_core::graph::app_sources(&core.root);
        self.imports.retain(|p, _| sources.contains(p));
        let mut by: std::collections::HashMap<PathBuf, Vec<PathBuf>> = Default::default();
        for src in sources {
            let meta = std::fs::metadata(&src).ok();
            let stamp = (
                meta.as_ref().and_then(|m| m.modified().ok()),
                meta.as_ref().map_or(0, |m| m.len()),
            );
            let fresh = self
                .imports
                .get(&src)
                .is_some_and(|(t, len, _)| (*t, *len) == stamp);
            if !fresh {
                let resolved = nowaki_core::graph::module_imports(core, &src)
                    .map(|imports| imports.into_iter().filter_map(|i| i.resolved).collect())
                    .unwrap_or_default();
                self.imports
                    .insert(src.clone(), (stamp.0, stamp.1, resolved));
            }
            for target in &self.imports[&src].2 {
                by.entry(target.clone()).or_default().push(src.clone());
            }
        }
        by
    }

    /// Records the class map the browser got for a CSS Module; returns whether it differs from
    /// the one recorded before (false the first time).
    fn css_map_changed(&mut self, abs: &Path, map: String) -> bool {
        match self.css_maps.insert(abs.to_path_buf(), map.clone()) {
            Some(old) => old != map,
            None => false,
        }
    }
}

/// What a batch of file changes does to open pages.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct HmrPlan {
    /// A full reload: config, env, session, content, a removed file, or a module no island or
    /// route imports.
    reload: bool,
    /// A route, layout or a module a route imports changed (a server-only `lib/` module too): the
    /// client refetches the page and morphs it in place.
    page: bool,
    /// Stylesheets to replace in place (the changed ones, and the ones that `@import` them).
    css: std::collections::BTreeSet<PathBuf>,
    /// Island entries to re-import, and every module between them and the change (all get new
    /// hot versions).
    islands: std::collections::BTreeSet<PathBuf>,
    modules: std::collections::BTreeSet<PathBuf>,
}

/// Most modules walked from one change before giving up and reloading.
const HMR_WALK_CAP: usize = 2000;

/// Whether `p` is an island entry (`islands/<name>.<ext>`, as the island registry reads them).
fn is_island_entry(root: &Path, p: &Path) -> bool {
    p.parent() == Some(root.join("islands").as_path())
        && matches!(
            p.extension().and_then(|e| e.to_str()),
            Some("tsx" | "jsx" | "ts" | "js" | "tsrx")
        )
}

/// Classifies a batch of changed files (see [`HmrPlan`]).
pub(crate) fn plan_changes(
    core: &NowakiCore,
    graph: &mut HmrGraph,
    changed: &[PathBuf],
    restart: bool,
) -> HmrPlan {
    let root = &core.root;
    let mut plan = HmrPlan {
        reload: restart,
        ..HmrPlan::default()
    };
    let mut walk: Vec<PathBuf> = Vec::new();
    for p in changed {
        let top = p
            .strip_prefix(root)
            .ok()
            .and_then(|r| r.components().next())
            .map(|c| c.as_os_str().to_string_lossy().into_owned());
        if !p.is_file() || top.as_deref() == Some("content") {
            plan.reload = true;
        } else if nowaki_core::css::is_css(p) {
            // A CSS Module whose class names changed: the modules importing it get the new map.
            let map_changed = nowaki_core::css::is_css_module(p)
                && core.read_css(p).is_ok_and(|css| {
                    let id = nowaki_core::css::css_scope_id(root, p);
                    let map = nowaki_core::css::scope_css(&id, &css).1;
                    graph.css_map_changed(p, nowaki_core::css::mapping_object(&map))
                });
            if map_changed {
                walk.push(p.clone());
            } else {
                plan.css.insert(p.clone());
                plan.css.extend(css_importers(core, p));
            }
        } else if is_transformable(p) {
            walk.push(p.clone());
        } else {
            plan.reload = true;
        }
    }
    if walk.is_empty() || plan.reload {
        return plan;
    }
    let importers = graph.importers(core);
    let mut seen: std::collections::HashSet<PathBuf> = Default::default();
    while let Some(p) = walk.pop() {
        if !seen.insert(p.clone()) {
            continue;
        }
        if seen.len() > HMR_WALK_CAP {
            plan.reload = true;
            break;
        }
        if is_island_entry(root, &p) {
            // The boundary: the browser re-imports the island; its own importers are routes
            // (SSR), which the next request renders with the new SSR version anyway.
            plan.islands.insert(p.clone());
            plan.modules.insert(p);
            continue;
        }
        if under(root, &p, &["routes"]) {
            plan.page = true;
            continue;
        }
        match importers.get(&p) {
            Some(by) if !by.is_empty() => {
                plan.modules.insert(p);
                walk.extend(by.iter().cloned());
            }
            // Nothing imports it. The changed file itself, or a file the framework loads
            // (session.ts, content/config.ts): reload. Another importer nothing loads (a test
            // file, a module not used yet) changes no page.
            _ if changed.contains(&p) || framework_entry(root, &p) => plan.reload = true,
            _ => {}
        }
    }
    plan
}

/// Server files the framework imports itself, outside `routes/` (no app module imports them).
fn framework_entry(root: &Path, p: &Path) -> bool {
    let top_level = p.parent() == Some(root)
        && p.file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| matches!(s, "session" | "env" | "nowaki.config"));
    top_level || p.starts_with(root.join("content"))
}

/// App stylesheets that `@import` `css` (directly or through others), which inline its text.
fn css_importers(core: &NowakiCore, css: &Path) -> Vec<PathBuf> {
    let mut sheets = Vec::new();
    css_files(&core.root, &mut sheets);
    sheets
        .into_iter()
        .filter(|s| s != css)
        .filter(|s| {
            let Ok(text) = std::fs::read_to_string(s) else {
                return false;
            };
            if !text.contains("@import") {
                return false;
            }
            let resolve = |dir: &Path, spec: &str| core.resolve_spec(dir, spec);
            let (_, inlined) = nowaki_core::css::inline_imports_with_files(s, &text, &resolve);
            inlined.iter().any(|f| f == css)
        })
        .collect()
}

/// `.css` files of the app (no dependencies, build output or dot directories).
fn css_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if !name.starts_with('.')
                && !matches!(name.as_ref(), "node_modules" | "dist" | "target")
            {
                css_files(&path, out);
            }
        } else if nowaki_core::css::is_css(&path) {
            out.push(path);
        }
    }
}

/// The HMR messages for a plan, with the log kind of each, in the order the client applies them:
/// stylesheets, then islands (`hot` bumps the hot versions of the modules it re-imports), then
/// the page (`page` refetches it; the islands it keeps already run the new code).
fn hmr_messages(core: &NowakiCore, plan: &HmrPlan) -> Vec<(&'static str, serde_json::Value)> {
    let root = &core.root;
    if plan.reload {
        return vec![("reload", json!({ "type": "reload" }))];
    }
    let mut out = Vec::new();
    if !plan.css.is_empty() {
        let files: Vec<_> = plan
            .css
            .iter()
            .map(|p| {
                json!({
                    "file": rel_name(root, p),
                    "id": nowaki_core::css::css_scope_id(root, p),
                    "url": nowaki_core::resolve::fs_path_to_url(root, p),
                })
            })
            .collect();
        out.push(("css", json!({ "type": "css", "files": files })));
    }
    // A change only routes reach (a server-only module) has no island to re-import.
    if !plan.modules.is_empty() && !(plan.page && plan.islands.is_empty()) {
        for m in &plan.modules {
            core.bump_dev_version(m);
        }
        let islands: Vec<_> = plan
            .islands
            .iter()
            .map(|p| {
                json!({
                    "src": nowaki_core::resolve::fs_path_to_url(root, p),
                    "url": core.dev_module_url(p),
                    "name": p.file_stem().map(|s| s.to_string_lossy().into_owned()),
                })
            })
            .collect();
        let modules: Vec<_> = plan
            .modules
            .iter()
            .map(|p| core.dev_module_url(p))
            .collect();
        out.push((
            "hot",
            json!({ "type": "hot", "islands": islands, "modules": modules }),
        ));
    }
    if plan.page {
        out.push(("page", json!({ "type": "page" })));
    }
    out
}

async fn hmr_ws(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    State(state): State<Arc<DevState>>,
) -> Response {
    if !ws_origin_ok(&headers, state.expose) {
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    ws.on_upgrade(move |socket| handle_hmr(socket, state))
}

/// WS for server-reactive islands. Session logic lives in crate::live.
async fn live_ws(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    State(state): State<Arc<DevState>>,
) -> Response {
    // Cross-site WebSocket hijacking (CSWSH) guard: reject cross-origin upgrades.
    if !ws_origin_ok(&headers, state.expose) {
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    let http = state.http.clone();
    let port = state.sidecar_port;
    // The current SSR version at each render: after a hot update, the open socket renders the
    // edited island with the state it holds.
    let versions = state.clone();
    let version: crate::live::Version =
        Arc::new(move || versions.ssr_version.load(Ordering::SeqCst).to_string());
    let hub = state.live_hub.clone();
    let request = crate::live::context_headers(&headers);
    ws.on_upgrade(move |socket| {
        crate::live::handle_versioned(socket, hub, http, port, version, request)
    })
}

async fn handle_hmr(mut socket: WebSocket, state: Arc<DevState>) {
    let mut rx = state.hmr_tx.subscribe();
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Ok(msg) = msg else { break };
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                if incoming.is_none() {
                    break;
                }
            }
        }
    }
}

/// Server function allowlist (id → { module, export }). Dev doesn't build, so
/// the sidecar looks RPCs up here to dispatch them.
async fn server_functions(State(state): State<Arc<DevState>>) -> Response {
    let core_state = state.clone();
    let body = tokio::task::spawn_blocking(move || {
        let found = nowaki_core::server_fn::discover(
            &core_state.core,
            &["routes", "islands", "components", "lib", "actions"],
        );
        let mut entries = serde_json::Map::new();
        for f in found {
            entries.insert(f.id, json!({ "module": f.source_rel, "export": f.export }));
        }
        json!({ "entries": entries }).to_string()
    })
    .await;
    match body {
        Ok(json) => (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            json,
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub struct SsrModuleQuery {
    path: String,
    #[allow(dead_code)] // cache buster (added by the Node loader)
    v: Option<String>,
}

/// SSR transform for the Node loader hook. `path` is user input, so canonicalize it and
/// only pass transformable, non-sensitive files under allowed roots (blocks arbitrary reads like `?path=/etc/passwd`).
async fn ssr_module(
    State(state): State<Arc<DevState>>,
    Query(q): Query<SsrModuleQuery>,
) -> Response {
    let Ok(canon) = dunce::canonicalize(&q.path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !fs_path_allowed(&canon, &state.fs_allow) || !is_transformable(&canon) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    transform_response(state, canon, Mode::Ssr).await
}

#[derive(serde::Deserialize)]
struct RouteCssQuery {
    file: String,
}

/// The stylesheets a route (and its layouts) imports, as `/__nowaki/css` URLs, for the dev
/// sidecar to link in the page head. Only route files under `routes/` are accepted.
/// A self-hosted font file built by `fonts::build_dev` (`.nowaki/fonts/<name>`; names only).
async fn dev_font(
    State(state): State<Arc<DevState>>,
    axum::extract::Path(file): axum::extract::Path<String>,
) -> Response {
    let ok = !file.is_empty()
        && !file.starts_with('.')
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    if !ok {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match tokio::fs::read(state.core.root.join(".nowaki/fonts").join(&file)).await {
        Ok(bytes) => (
            [
                (
                    header::CONTENT_TYPE,
                    nowaki_core::public::content_type(&file),
                ),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[derive(serde::Deserialize)]
struct ImageVariantQuery {
    /// The image's dev URL (`/photo.png`, or `/@fs/...` outside the root).
    f: String,
    w: u32,
    /// `avif` or `orig` (the source format, resized).
    fmt: String,
    q: Option<u8>,
}

/// One `?image` variant in dev, encoded on first request (cached on disk by nowaki-core). The file
/// must be one the dev server would serve anyway: under the root, or an allowed /@fs/ root.
async fn dev_image(
    State(state): State<Arc<DevState>>,
    Query(q): Query<ImageVariantQuery>,
) -> Response {
    let requested = match q.f.strip_prefix("/@fs/") {
        Some(rest) => nowaki_core::resolve::fs_url_to_path(rest),
        None => state.core.root.join(q.f.trim_start_matches('/')),
    };
    let Ok(canon) = dunce::canonicalize(&requested) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let allowed = (canon.starts_with(&state.core.root) && !is_denied_fs_path(&canon))
        || fs_path_allowed(&canon, &state.fs_allow);
    if !allowed || !nowaki_core::is_asset(&canon) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let root = state.core.root.clone();
    let avif = q.fmt == "avif";
    let out = tokio::task::spawn_blocking(move || {
        nowaki_core::image::dev_variant(&root, &canon, q.w, avif, q.q)
    })
    .await;
    match out {
        Ok(Ok((bytes, mime))) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn route_css(State(state): State<Arc<DevState>>, Query(q): Query<RouteCssQuery>) -> Response {
    let routes_dir = state.core.root.join("routes");
    let Ok(canon) = dunce::canonicalize(&q.file) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let Some(rel) = canon
        .strip_prefix(&routes_dir)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
    else {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    };
    let core_state = state.clone();
    let hrefs = tokio::task::spawn_blocking(move || {
        let mut entries = nowaki_core::budget::layouts_for(&routes_dir, &rel);
        entries.push(canon);
        nowaki_core::route_css::css_of(&core_state.core, &entries)
            .into_iter()
            .map(|css| {
                let shown = css
                    .strip_prefix(&core_state.core.root)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| css.to_string_lossy().into_owned());
                format!("/__nowaki/css?f={}", query_encode(&shown))
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        serde_json::to_string(&hrefs).unwrap_or_else(|_| "[]".into()),
    )
        .into_response()
}

/// Percent-encodes a query value (unreserved characters and `/` stay as they are).
pub(crate) fn query_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct DevCssQuery {
    f: String,
}

/// One stylesheet in dev (CSS Modules scoped like their JS). `f` is user input: it must resolve
/// to a `.css` file under an allowed root.
async fn dev_css(State(state): State<Arc<DevState>>, Query(q): Query<DevCssQuery>) -> Response {
    let requested = state.core.root.join(&q.f);
    let Ok(canon) = dunce::canonicalize(&requested) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !fs_path_allowed(&canon, &state.fs_allow) || !nowaki_core::css::is_css(&canon) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let Ok(css) = state.core.read_css(&canon) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let sheet = if nowaki_core::css::is_css_module(&canon) {
        let id = nowaki_core::css::css_scope_id(&state.core.root, &canon);
        let (scoped, map) = nowaki_core::css::scope_css(&id, &css);
        state.record_css_map(&canon, &map);
        scoped
    } else {
        css
    };
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        sheet,
    )
        .into_response()
}

/// /@fs/<absolute path>: serves files outside the app root (pnpm store etc.). `rest` is user input, so
/// canonicalize it, then check it's under an allowed root and non-sensitive (prevents path traversal).
async fn serve_fs(
    State(state): State<Arc<DevState>>,
    axum::extract::Path(rest): axum::extract::Path<String>,
) -> Response {
    let requested = nowaki_core::resolve::fs_url_to_path(&rest);
    let Ok(canon) = dunce::canonicalize(&requested) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !fs_path_allowed(&canon, &state.fs_allow) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    serve_file(state, canon).await
}

/// Fallback: serve the file if it's under the app root, otherwise proxy SSR to the sidecar
async fn serve_or_proxy(State(state): State<Arc<DevState>>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    if crate::forward::is_internal_path(&path) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let read = matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    // nowaki.config routing. Dev module URLs (the app's own files, the runtime, virtual modules)
    // are served ahead of it, at the root, where the pages reference them.
    let route_path = match &state.front {
        Some(front) if !dev_module_url(&state.core.root, &path, read) => {
            match front.apply(req.method(), req.uri()) {
                crate::front::Step::Respond(resp) => return resp,
                crate::front::Step::Continue(route_path) => route_path,
            }
        }
        _ => None,
    };
    let lookup = route_path.as_deref().unwrap_or(&path);
    // public/ files are sent as they are (no CSS shim, no TS transform), ahead of routes.
    if read {
        if let Some(resp) = serve_public(&state, lookup).await {
            return resp;
        }
    }
    // Virtual ids never contain `..`, so reject it (prevents traversal via root.join when the synthetic dir exists).
    if path.starts_with(&format!("/{VIRTUAL_DIR}/")) {
        if path.split('/').any(|seg| seg == "..") {
            return (StatusCode::NOT_FOUND, "not found").into_response();
        }
        let abs = state.core.root.join(path.trim_start_matches('/'));
        return transform_response(state, abs, Mode::Browser).await;
    }
    if read && path != "/" {
        if let Some(candidate) = app_file(&state.core.root, &path) {
            return serve_file(state, candidate).await;
        }
    }
    proxy_to_sidecar(state, req, route_path).await
}

/// URLs `nowaki dev` serves itself, which config rules never apply to: framework endpoints, the
/// runtime and dependencies, virtual modules, islands, and any other file of the app.
fn dev_module_url(root: &Path, path: &str, read: bool) -> bool {
    path.starts_with("/__nowaki/")
        || path.starts_with("/node_modules/")
        || path.starts_with("/islands/")
        || path
            .strip_prefix('/')
            .and_then(|p| p.strip_prefix(VIRTUAL_DIR))
            .is_some_and(|p| p.starts_with('/'))
        || (read && path != "/" && app_file(root, path).is_some())
}

/// The app file a request path names, decoded (the renderer writes island and script URLs
/// unencoded, so the browser asks for `/islands/Cnt%20%C3%84.tsx`). None for a malformed escape,
/// a `.` / `..` / empty segment, a backslash or NUL, a missing file, a real path that leaves the
/// root (via a symlink), a sensitive file, or a file under `public/` (served at its own URL, `/x`
/// for `public/x`, not at `/public/x` as in production). `root` is canonical (main.rs).
fn app_file(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = nowaki_core::public::percent_decode(url_path)?;
    if decoded == "/public" || decoded.starts_with("/public/") {
        return None;
    }
    let mut candidate = root.to_path_buf();
    for seg in decoded.strip_prefix('/')?.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(['\\', '\0']) {
            return None;
        }
        candidate.push(seg);
    }
    if !candidate.is_file() {
        return None;
    }
    let canon = dunce::canonicalize(&candidate).ok()?;
    if is_denied_fs_path(&canon) {
        return None;
    }
    (canon.starts_with(root) || in_runtime_package(root, &decoded, &canon)).then_some(candidate)
}

/// The page loads the client runtime from `/node_modules/@nowaki-dev/runtime/client/*`. In a pnpm
/// workspace or after `npm link` that package is a symlink whose real path is outside the root, so
/// it is allowed by name: only files inside the package's own real directory, nothing it links to.
fn in_runtime_package(root: &Path, decoded: &str, canon: &Path) -> bool {
    const RUNTIME: &str = "/node_modules/@nowaki-dev/runtime/";
    if !decoded.starts_with(RUNTIME) {
        return false;
    }
    let Ok(pkg) = dunce::canonicalize(root.join("node_modules/@nowaki-dev/runtime")) else {
        return false;
    };
    canon
        .strip_prefix(&pkg)
        .is_ok_and(|rest| !rest.components().any(|c| c.as_os_str() == "node_modules"))
}

/// `public/<path>` for `/<path>`, read on each request so added or edited files show up at once.
/// The real path must stay inside `public/` (a symlink pointing out of it is refused).
async fn serve_public(state: &DevState, url_path: &str) -> Option<Response> {
    let base = nowaki_core::public::dir(&state.core.root);
    let candidate = nowaki_core::public::resolve(&base, url_path)?;
    if !candidate.is_file() {
        return None;
    }
    let canon_base = dunce::canonicalize(&base).ok()?;
    let canon = dunce::canonicalize(&candidate).ok()?;
    if !canon.starts_with(&canon_base) || is_denied_fs_path(&canon) {
        return None;
    }
    let bytes = tokio::fs::read(&canon).await.ok()?;
    Some(
        (
            [
                (
                    header::CONTENT_TYPE,
                    nowaki_core::public::content_type(url_path),
                ),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
    )
}

async fn serve_file(state: Arc<DevState>, abs: PathBuf) -> Response {
    // Serve .css as a JS shim that injects a <style> (applied as an import side effect).
    // *.module.css scopes class names and default-exports the name map.
    if nowaki_core::css::is_css(&abs) {
        return match state.core.read_css(&abs) {
            Ok(css) => {
                let id = nowaki_core::css::css_scope_id(&state.core.root, &abs);
                let shim = if nowaki_core::css::is_css_module(&abs) {
                    let (scoped, map) = nowaki_core::css::scope_css(&id, &css);
                    state.record_css_map(&abs, &map);
                    nowaki_core::css::css_module_client_js(&id, &scoped, &map)
                } else {
                    nowaki_core::css::css_shim(&id, &css)
                };
                (
                    [
                        (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
                        (header::CACHE_CONTROL, "no-cache"),
                    ],
                    shim,
                )
                    .into_response()
            }
            Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
        };
    }
    if is_transformable(&abs) {
        return transform_response(state, abs, Mode::Browser).await;
    }
    match tokio::fs::read(&abs).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime_for(&abs))], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn transform_response(state: Arc<DevState>, abs: PathBuf, mode: Mode) -> Response {
    // oxc transforms are CPU-bound, so run them on the blocking pool
    let core_state = state.clone();
    let file = abs.clone();
    let result = tokio::task::spawn_blocking(move || core_state.core.load_module(&abs, mode)).await;
    match result {
        Ok(Ok(code)) => (
            [
                (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            code,
        )
            .into_response(),
        Ok(Err(err)) => {
            let msg = format!("{err:#}");
            eprintln!("[nowaki] transform error: {msg}");
            state.errors.record("build", &msg, Some(&file), None, None);
            // Diagnostics may contain the full source, so keep them out of the HTTP body and send them only to the same-origin HMR overlay.
            let _ = state
                .hmr_tx
                .send(json!({ "type": "error", "message": msg }).to_string());
            (StatusCode::INTERNAL_SERVER_ERROR, "transform error").into_response()
        }
        Err(join_err) => (StatusCode::INTERNAL_SERVER_ERROR, join_err.to_string()).into_response(),
    }
}

async fn proxy_to_sidecar(
    state: Arc<DevState>,
    req: Request,
    route_path: Option<String>,
) -> Response {
    let started = Instant::now();
    let path_q = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("http://127.0.0.1:{}{}", state.sidecar_port, path_q);
    let method = req.method().clone();
    let method_str = method.to_string();
    let log_path = req.uri().path().to_string();
    let headers = req.headers().clone();

    let body = match axum::body::to_bytes(req.into_body(), 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };

    let mut builder = state
        .http
        .request(method, &url)
        .header(
            "x-nowaki-ssr-version",
            state.ssr_version.load(Ordering::SeqCst).to_string(),
        )
        .body(body.to_vec());
    builder = crate::forward::apply(builder, &headers, crate::forward::trust_proxy());
    // After forward::apply, which drops a client's own value of this header.
    if let Some(r) = &route_path {
        builder = builder.header(crate::front::ROUTE_PATH_HEADER, r);
    }

    match builder.send().await {
        Ok(resp) => {
            let status = resp.status();
            crate::ui::request_log(
                &method_str,
                &log_path,
                status.as_u16(),
                started.elapsed().as_millis(),
            );
            let mut response = Response::builder().status(status.as_u16());
            for (name, value) in resp.headers().iter() {
                if name != header::TRANSFER_ENCODING && name != header::CONTENT_LENGTH {
                    response = response.header(name, value);
                }
            }
            // Streamed through as the sidecar writes it (streaming SSR, SSE, large API bodies).
            response
                .body(Body::from_stream(resp.bytes_stream()))
                .unwrap_or_else(|e| {
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
                })
        }
        Err(err) => {
            crate::ui::request_log(&method_str, &log_path, 502, started.elapsed().as_millis());
            (
                StatusCode::BAD_GATEWAY,
                format!("failed to connect to SSR sidecar: {err}"),
            )
                .into_response()
        }
    }
}

/// Allowed roots for /@fs/: the app root and workspace root (shared node_modules in pnpm/monorepos).
/// Anything else (`/etc`, home, `.env` outside the root, etc.) is rejected.
fn compute_fs_allow(root: &Path) -> Vec<PathBuf> {
    let mut allow = Vec::new();
    if let Ok(c) = dunce::canonicalize(root) {
        allow.push(c);
    }
    if let Some(ws) = workspace_root(root) {
        if let Ok(c) = dunce::canonicalize(&ws) {
            if !allow.contains(&c) {
                allow.push(c);
            }
        }
    }
    allow
}

/// Nearest workspace boundary (`pnpm-workspace.yaml` or `.git`).
fn workspace_root(root: &Path) -> Option<PathBuf> {
    let mut dir = Some(root);
    while let Some(d) = dir {
        if d.join("pnpm-workspace.yaml").is_file() || d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Sensitive paths refused even under allowed roots (inside `.git`, `.env*`, private keys).
pub(crate) fn is_denied_fs_path(p: &Path) -> bool {
    p.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == ".git" || s == ".env" || s.starts_with(".env.")
    }) || matches!(p.extension().and_then(|e| e.to_str()), Some("pem" | "key"))
}

fn fs_path_allowed(canon: &Path, allow: &[PathBuf]) -> bool {
    !is_denied_fs_path(canon) && allow.iter().any(|root| canon.starts_with(root))
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    let h = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else if host.matches(':').count() >= 2 {
        // Unbracketed IPv6 (e.g. `::1`) has no port.
        host
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    matches!(h, "localhost" | "127.0.0.1" | "::1")
}

/// DNS-rebinding guard for every dev route. On the default bind (127.0.0.1) a page on another
/// domain can rebind its name to 127.0.0.1 and read dev responses same-origin: server-only source
/// with its source map, `/@fs/` files, `.npmrc`. The browser still sends the attacker's name as
/// `Host`, so only `localhost` / `127.0.0.1` / `[::1]` are accepted. `--host` exposes the server on
/// purpose and accepts any Host. A request without Host (no browser sends one) is let through.
pub(crate) fn dev_host_allowed(headers: &axum::http::HeaderMap, expose: bool) -> bool {
    if expose {
        return true;
    }
    match headers.get(header::HOST) {
        None => true,
        Some(v) => v.to_str().is_ok_and(is_loopback_host),
    }
}

async fn host_guard(
    State(expose): State<bool>,
    req: Request,
    next: axum::middleware::Next,
) -> Response {
    if dev_host_allowed(req.headers(), expose) {
        return next.run(req).await;
    }
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("?");
    (
        StatusCode::FORBIDDEN,
        format!(
            "Blocked request: Host \"{host}\" is not allowed by the dev server. \
             Open it at localhost, or start `nowaki dev --host` to accept other hosts.\n"
        ),
    )
        .into_response()
}

/// Validate the WebSocket upgrade Origin (CSWSH guard). No Origin (non-browser) is allowed;
/// same-origin is allowed, but on the default bind Host must be loopback to defeat DNS rebinding.
fn ws_origin_ok(headers: &axum::http::HeaderMap, expose: bool) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let Some(origin) = origin else {
        return true;
    };
    let Some(origin_host) = origin.split("://").nth(1).map(|h| h.trim_end_matches('/')) else {
        return false;
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    if let Some(host) = host {
        if origin_host == host {
            return expose || is_loopback_host(host);
        }
    }
    // Even without a Host match, an explicit loopback Origin (localhost:port etc.) is allowed.
    is_loopback_host(origin_host)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_allow_roots() {
        let allow = vec![PathBuf::from("/proj/node_modules")];
        // Reject paths outside allowed roots (arbitrary file reads)
        assert!(!fs_path_allowed(Path::new("/etc/passwd"), &allow));
        assert!(!fs_path_allowed(Path::new("/home/u/.ssh/id_rsa"), &allow));
        // Also reject prefix-match slips (sibling directories)
        assert!(!fs_path_allowed(
            Path::new("/proj/node_modules_evil/x"),
            &allow
        ));
    }

    #[test]
    fn allows_paths_under_allow_roots() {
        let allow = vec![PathBuf::from("/proj/node_modules")];
        assert!(fs_path_allowed(
            Path::new("/proj/node_modules/.pnpm/preact@10/node_modules/preact/index.js"),
            &allow,
        ));
    }

    #[test]
    fn denies_sensitive_files_even_within_allow_roots() {
        let allow = vec![PathBuf::from("/proj")];
        // Never serve .env / inside .git / private keys, even under allowed roots
        assert!(!fs_path_allowed(Path::new("/proj/.env"), &allow));
        assert!(!fs_path_allowed(Path::new("/proj/.env.local"), &allow));
        assert!(!fs_path_allowed(Path::new("/proj/.git/config"), &allow));
        assert!(!fs_path_allowed(Path::new("/proj/keys/server.pem"), &allow));
        assert!(!fs_path_allowed(Path::new("/proj/id_rsa.key"), &allow));
        assert!(fs_path_allowed(
            Path::new("/proj/packages/ui/Button.tsx"),
            &allow
        ));
    }

    #[test]
    fn is_denied_fs_path_matches_components_not_substrings() {
        // Don't misfire on directories whose name merely contains ".env"
        assert!(!is_denied_fs_path(Path::new("/proj/environments/dev.js")));
        assert!(is_denied_fs_path(Path::new("/proj/.env.production")));
    }

    fn hdrs(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn ws_origin_rejects_cross_site() {
        // Default bind: reject cross-origin connections to localhost (CSWSH)
        let h = hdrs(&[("host", "localhost:3000"), ("origin", "http://evil.com")]);
        assert!(!ws_origin_ok(&h, false));
        assert!(!ws_origin_ok(&h, true));
    }

    #[test]
    fn ws_origin_allows_same_origin_loopback() {
        let h = hdrs(&[
            ("host", "localhost:3000"),
            ("origin", "http://localhost:3000"),
        ]);
        assert!(ws_origin_ok(&h, false));
        let h2 = hdrs(&[
            ("host", "127.0.0.1:3000"),
            ("origin", "http://127.0.0.1:3000"),
        ]);
        assert!(ws_origin_ok(&h2, false));
    }

    #[test]
    fn ws_origin_defeats_dns_rebinding_on_default_bind() {
        // Origin==Host but Host is non-loopback → rejected on default bind, allowed with --host
        let h = hdrs(&[
            ("host", "attacker.test:3000"),
            ("origin", "http://attacker.test:3000"),
        ]);
        assert!(!ws_origin_ok(&h, false));
        assert!(ws_origin_ok(&h, true));
    }

    #[test]
    fn ws_origin_allows_missing_origin() {
        // Native WS clients (no Origin) are allowed
        let h = hdrs(&[("host", "localhost:3000")]);
        assert!(ws_origin_ok(&h, false));
    }

    #[test]
    fn ws_origin_lan_same_origin_under_host() {
        // With --host, same-origin on a LAN IP is allowed
        let h = hdrs(&[
            ("host", "192.168.1.10:3000"),
            ("origin", "http://192.168.1.10:3000"),
        ]);
        assert!(ws_origin_ok(&h, true));
        assert!(!ws_origin_ok(&h, false));
    }

    #[test]
    fn loopback_host_parsing() {
        assert!(is_loopback_host("localhost:3000"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("[::1]:3000"));
        assert!(is_loopback_host("::1"));
        assert!(!is_loopback_host("192.168.1.10:3000"));
        assert!(!is_loopback_host("evil.com"));
    }

    #[test]
    fn dev_host_guard_defeats_dns_rebinding() {
        for ok in [
            "localhost:3000",
            "127.0.0.1:3000",
            "[::1]:3000",
            "localhost",
        ] {
            assert!(dev_host_allowed(&hdrs(&[("host", ok)]), false), "{ok}");
        }
        for bad in [
            "attacker.test:3000",
            "192.168.1.10:3000",
            "localhost.evil.com",
        ] {
            assert!(!dev_host_allowed(&hdrs(&[("host", bad)]), false), "{bad}");
            // --host exposes the server on purpose (LAN IPs, custom names).
            assert!(dev_host_allowed(&hdrs(&[("host", bad)]), true), "{bad}");
        }
        assert!(dev_host_allowed(&hdrs(&[]), false));
    }

    /// The guard is a layer, so it covers the fallback (app files) and every `/__nowaki/*` route.
    #[tokio::test]
    async fn dev_host_guard_layer_refuses_a_rebound_host() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let app = Router::new()
            .route("/@fs/{*path}", get(|| async { "file" }))
            .fallback(|| async { "secret" })
            .layer(axum::middleware::from_fn_with_state(false, host_guard));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        let get = |path: &'static str, host: String| async move {
            let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
            let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
            s.write_all(req.as_bytes()).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        };
        let port = addr.port();
        for path in ["/lib/secret.server.ts", "/@fs/etc/x", "/.npmrc"] {
            let r = get(path, format!("attacker.test:{port}")).await;
            assert!(r.starts_with("HTTP/1.1 403"), "{path}: {r}");
            assert!(!r.contains("secret\r") && !r.ends_with("secret"), "{r}");
            let r = get(path, format!("localhost:{port}")).await;
            assert!(r.starts_with("HTTP/1.1 200"), "{path}: {r}");
        }
        server.abort();
    }

    #[test]
    fn app_file_decodes_the_request_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("islands")).unwrap();
        std::fs::write(root.join("islands/Cnt Ä.tsx"), "x").unwrap();
        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("public/robots.txt"), "User-agent: *").unwrap();
        assert_eq!(
            app_file(&root, "/islands/Cnt%20%C3%84.tsx"),
            Some(root.join("islands").join("Cnt Ä.tsx"))
        );
        for bad in [
            "/islands/Cnt%20%C3%8",
            "/islands/Cnt%zz.tsx",
            "/islands/%2e%2e/islands/Cnt%20%C3%84.tsx",
            "/islands/..%2fislands/Cnt%20%C3%84.tsx",
            "/islands%5cCnt%20%C3%84.tsx",
            "/%2eenv",
            "/.env",
            "/islands/missing.tsx",
            "/public/robots.txt",
            "/%70ublic/robots.txt",
        ] {
            assert_eq!(app_file(&root, bad), None, "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn app_file_serves_a_symlinked_runtime_package_only() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let root = base.join("app");
        let pkg = base.join("packages/nowaki-runtime");
        std::fs::create_dir_all(root.join("node_modules/@nowaki-dev")).unwrap();
        std::fs::create_dir_all(pkg.join("client")).unwrap();
        std::fs::create_dir_all(pkg.join("node_modules/dep")).unwrap();
        std::fs::write(pkg.join("client/islands.js"), "x").unwrap();
        std::fs::write(pkg.join("node_modules/dep/index.js"), "x").unwrap();
        std::fs::write(pkg.join(".env"), "SECRET=1").unwrap();
        std::fs::write(base.join("secret.txt"), "s").unwrap();
        symlink(base.join("secret.txt"), pkg.join("client/leak.js")).unwrap();
        symlink(&pkg, root.join("node_modules/@nowaki-dev/runtime")).unwrap();
        symlink(&base, root.join("node_modules/other")).unwrap();
        assert!(app_file(&root, "/node_modules/@nowaki-dev/runtime/client/islands.js").is_some());
        for bad in [
            "/node_modules/@nowaki-dev/runtime/client/leak.js",
            "/node_modules/@nowaki-dev/runtime/node_modules/dep/index.js",
            "/node_modules/@nowaki-dev/runtime/.env",
            "/node_modules/other/secret.txt",
            "/node_modules/@nowaki-dev/runtime/../../secret.txt",
        ] {
            assert_eq!(app_file(&root, bad), None, "{bad}");
        }
    }

    #[test]
    fn startup_files_need_a_restart_others_do_not() {
        let root = Path::new("/app");
        let paths: Vec<PathBuf> = [
            "/app/.env",
            "/app/env.ts",
            "/app/nowaki.config.mjs",
            "/app/routes/index.tsx",
            "/app/session.ts",
            "/app/.env.example",
            "/app/lib/env.ts",
            "/app/routes/nowaki.config.mjs",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(
            needs_restart(root, &paths),
            [".env", "env.ts", "nowaki.config.mjs"]
        );
        assert!(needs_restart(root, &[PathBuf::from("/app/islands/A.tsx")]).is_empty());
        assert_eq!(
            needs_restart(root, &[PathBuf::from("/app/.env.local")]),
            [".env.local"]
        );
    }

    /// An app for `plan_changes`: islands, a util only islands use, a component a route uses
    /// too, stylesheets with an `@import`, a CSS Module, and session.ts.
    fn hmr_app() -> (tempfile::TempDir, NowakiCore) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let files = [
            ("routes/index.tsx", "import C from \"../islands/Counter.tsx\";\nimport Shared from \"../components/Shared.tsx\";\nimport { rows } from \"../lib/db.ts\";\nimport \"../styles/a.css\";\nexport default () => <main><C /><Shared />{rows}</main>;\n"),
            ("islands/Counter.tsx", "import { label } from \"../lib/label.ts\";\nimport s from \"./S.module.css\";\nexport default function Counter() { return <b class={s.x}>{label}</b>; }\n"),
            ("islands/Other.tsx", "import Shared from \"../components/Shared.tsx\";\nexport default function Other() { return <Shared />; }\n"),
            ("lib/label.ts", "export const label = \"n\";\n"),
            ("lib/db.ts", "import { conn } from \"./conn.ts\";\nexport const rows = conn;\n"),
            ("lib/conn.ts", "export const conn = 1;\n"),
            ("components/Shared.tsx", "export default function Shared() { return <i>s</i>; }\n"),
            ("styles/a.css", "@import \"./b.css\";\n.a { color: red; }\n"),
            ("styles/b.css", ".b { color: blue; }\n"),
            ("islands/S.module.css", ".x { color: red; }\n"),
            ("session.ts", "import { secret } from \"./lib/auth.ts\";\nexport default { secret };\n"),
            ("lib/auth.ts", "export const secret = \"s\";\n"),
            ("lib/label.test.ts", "import { label } from \"./label.ts\";\nlabel;\n"),
        ];
        for (file, text) in files {
            let p = root.join(file);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        (dir, NowakiCore::new(root))
    }

    #[test]
    fn hmr_plan_island_only_chains_are_hot() {
        // (lib/label.test.ts imports the util too; nothing loads it, so it changes nothing.)
        let (_dir, core) = hmr_app();
        let root = core.root.clone();
        let mut graph = HmrGraph::default();
        let plan = plan_changes(&core, &mut graph, &[root.join("lib/label.ts")], false);
        assert_eq!(
            plan,
            HmrPlan {
                islands: [root.join("islands/Counter.tsx")].into(),
                modules: [root.join("islands/Counter.tsx"), root.join("lib/label.ts")].into(),
                ..HmrPlan::default()
            }
        );
        // The island itself: the routes importing it (SSR) don't make it a page update.
        let plan = plan_changes(
            &core,
            &mut graph,
            &[root.join("islands/Counter.tsx")],
            false,
        );
        assert!(!plan.page && !plan.reload, "{plan:?}");
        assert_eq!(plan.islands, [root.join("islands/Counter.tsx")].into());

        // The messages bump exactly those modules, and carry their new URLs.
        let msgs = hmr_messages(
            &core,
            &plan_changes(&core, &mut graph, &[root.join("lib/label.ts")], false),
        );
        assert_eq!(msgs.len(), 1);
        let (kind, msg) = &msgs[0];
        assert_eq!(*kind, "hot");
        let v = core.dev_version(&root.join("islands/Counter.tsx")).unwrap();
        assert_eq!(msg["islands"][0]["src"], "/islands/Counter.tsx");
        assert_eq!(
            msg["islands"][0]["url"],
            format!("/islands/Counter.tsx?t={v}")
        );
        assert_eq!(msg["islands"][0]["name"], "Counter");
        assert!(core.dev_version(&root.join("lib/label.ts")).is_some());
        assert!(core
            .dev_version(&root.join("components/Shared.tsx"))
            .is_none());
    }

    #[test]
    fn hmr_plan_routes_and_server_modules_update_the_page_framework_files_reload() {
        let (_dir, core) = hmr_app();
        let root = core.root.clone();
        let mut graph = HmrGraph::default();
        // A component an island and a route import: the island is re-imported first, then the
        // page refetched (it keeps that island, which already runs the new code).
        let plan = plan_changes(
            &core,
            &mut graph,
            &[root.join("components/Shared.tsx")],
            false,
        );
        assert!(plan.page && !plan.reload, "{plan:?}");
        assert_eq!(plan.islands, [root.join("islands/Other.tsx")].into());
        let msgs = hmr_messages(&core, &plan);
        let kinds: Vec<_> = msgs.iter().map(|(k, _)| *k).collect();
        assert_eq!(kinds, ["hot", "page"]);
        assert_eq!(msgs[0].1["islands"][0]["src"], "/islands/Other.tsx");
        assert_eq!(msgs[1].1, json!({ "type": "page" }));
        let plan = plan_changes(&core, &mut graph, &[root.join("routes/index.tsx")], false);
        assert!(plan.page && plan.islands.is_empty(), "{plan:?}");
        assert_eq!(
            hmr_messages(&core, &plan),
            [("page", json!({ "type": "page" }))]
        );
        // Server-only modules only routes reach (directly or through another): a page update,
        // with no hot versions bumped (the browser never imports them).
        for lib in ["lib/db.ts", "lib/conn.ts"] {
            let plan = plan_changes(&core, &mut graph, &[root.join(lib)], false);
            assert!(
                plan.page && !plan.reload && plan.islands.is_empty(),
                "{lib}: {plan:?}"
            );
            assert_eq!(
                hmr_messages(&core, &plan),
                [("page", json!({ "type": "page" }))]
            );
            assert!(core.dev_version(&root.join(lib)).is_none(), "{lib}");
        }
        // With a stylesheet in the same batch: the CSS first, then the page.
        let plan = plan_changes(
            &core,
            &mut graph,
            &[root.join("lib/db.ts"), root.join("styles/b.css")],
            false,
        );
        let kinds: Vec<_> = hmr_messages(&core, &plan)
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(kinds, ["css", "page"]);
        // Loaded by the framework, not imported: session.ts (and what it imports) reloads.
        let plan = plan_changes(&core, &mut graph, &[root.join("session.ts")], false);
        assert!(plan.reload, "{plan:?}");
        let plan = plan_changes(&core, &mut graph, &[root.join("lib/auth.ts")], false);
        assert!(plan.reload, "{plan:?}");
        assert_eq!(hmr_messages(&core, &plan)[0].1, json!({ "type": "reload" }));
        let plan = plan_changes(&core, &mut graph, &[root.join("islands/Gone.tsx")], false);
        assert!(plan.reload, "{plan:?}");
        // nowaki.config / env.ts / .env (needs_restart) reload whatever else changed.
        let plan = plan_changes(&core, &mut graph, &[root.join("lib/label.ts")], true);
        assert!(plan.reload, "{plan:?}");
    }

    #[test]
    fn hmr_plan_css_swaps_in_place_unless_class_names_change() {
        let (_dir, core) = hmr_app();
        let root = core.root.clone();
        let mut graph = HmrGraph::default();
        // b.css is inlined into a.css (the route links a.css), so both are replaced.
        let plan = plan_changes(&core, &mut graph, &[root.join("styles/b.css")], false);
        assert_eq!(
            plan,
            HmrPlan {
                css: [root.join("styles/a.css"), root.join("styles/b.css")].into(),
                ..HmrPlan::default()
            }
        );
        let (kind, msg) = &hmr_messages(&core, &plan)[0];
        assert_eq!(*kind, "css");
        assert_eq!(msg["files"][1]["file"], "styles/b.css");
        assert_eq!(msg["files"][1]["url"], "/styles/b.css");

        // A CSS Module rule change is CSS; a renamed class re-imports its importers.
        let module = root.join("islands/S.module.css");
        let map = |css: &str| {
            let id = nowaki_core::css::css_scope_id(&root, &module);
            nowaki_core::css::mapping_object(&nowaki_core::css::scope_css(&id, css).1)
        };
        graph
            .css_maps
            .insert(module.clone(), map(".x { color: red; }"));
        std::fs::write(&module, ".x { color: blue; }\n").unwrap();
        let plan = plan_changes(&core, &mut graph, std::slice::from_ref(&module), false);
        assert_eq!(plan.css, [module.clone()].into());
        assert!(plan.modules.is_empty());
        std::fs::write(&module, ".y { color: blue; }\n").unwrap();
        let plan = plan_changes(&core, &mut graph, std::slice::from_ref(&module), false);
        assert!(plan.css.is_empty(), "{plan:?}");
        assert_eq!(plan.islands, [root.join("islands/Counter.tsx")].into());
        assert!(plan.modules.contains(&module));
    }
}
