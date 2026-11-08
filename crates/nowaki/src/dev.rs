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
}

pub async fn run(root: PathBuf, port: u16, expose: bool, open: bool) -> Result<()> {
    let started = Instant::now();

    crate::typegen::write(&root).ok();
    // nowaki.config is read through Node while the sidecar and plugin host start, and joined
    // before serving: routing (.nowaki/routing.json) must be in place for the first request.
    let config = {
        let root = root.clone();
        std::thread::spawn(move || crate::site::config(&root))
    };

    let live_hub = crate::live::LiveHub::new();
    let errors = crate::mcp::ErrorLog::new(&root);
    let sidecar = sidecar::spawn(&root, port, live_hub.clone(), errors.clone()).await?;

    let plugin_host = crate::plugins::start(&root)?;
    let mut core = NowakiCore::new(root.clone());
    if let Some(ph) = &plugin_host {
        core.set_plugins(ph.bridge.clone());
    }

    // An invalid config is reported (site-config.mjs printed why) and dev runs without it.
    let config = config
        .join()
        .map_err(|_| anyhow::anyhow!("reading nowaki.config panicked"))?
        .unwrap_or_else(|e| {
            eprintln!("[nowaki] {e:#}");
            serde_json::Value::Object(Default::default())
        });
    if let Err(e) = crate::site::write_dev(&root, &config) {
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
    });

    dev_content(&state);
    let _watcher = start_watcher(&root, state.clone())?;

    let app = Router::new()
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
        .fallback(serve_or_proxy)
        .with_state(state)
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
        r = std::future::IntoFuture::into_future(axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )) => r?,
        _ = crate::shutdown::signal() => {}
    }
    drop(plugin_host);
    drop(sidecar);
    Ok(())
}

/// File watch → bump ssr_version + broadcast reload (100ms debounce)
/// Content collections in dev: re-read content/ into .nowaki/content/index.json, which the
/// sidecar loads for the next SSR version. A bad file is reported (overlay, MCP) and the last
/// good output is kept.
fn dev_content(state: &DevState) {
    let root = &state.core.root;
    if !crate::content::enabled(root) {
        return;
    }
    crate::typegen::write(root).ok();
    if let Err(e) = crate::content::write(
        root,
        &root.join(".nowaki/content"),
        &crate::content::Images::Dev,
    ) {
        let msg = format!("{e:#}");
        eprintln!("[nowaki] content: {msg}");
        state.errors.record("build", &msg, None, None, None);
    }
}

fn start_watcher(root: &Path, state: Arc<DevState>) -> Result<notify::RecommendedWatcher> {
    let root_owned = root.to_path_buf();
    // notify's callback only filters and forwards; a worker thread batches the changes and
    // reloads once they have been quiet for 100 ms. One save (several events) is one reload, a
    // second quick save is never dropped, and nothing blocks notify's thread.
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
            while let Ok(more) = rx.recv_timeout(Duration::from_millis(100)) {
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

fn apply_changes(state: &DevState, relevant: Vec<PathBuf>) {
    let root = &state.core.root;
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
    let island_only = relevant.iter().all(|p| under(root, p, &["islands"]));
    let kind = if island_only { "update" } else { "reload" };
    let files: Vec<String> = relevant
        .iter()
        .map(|p| {
            p.strip_prefix(root)
                .unwrap_or(p)
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    crate::ui::hmr_log(kind, &files);
    let _ = state.hmr_tx.send(json!({ "type": kind }).to_string());
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
    let version = state.ssr_version.load(Ordering::SeqCst).to_string();
    let hub = state.live_hub.clone();
    let request = crate::live::context_headers(&headers);
    ws.on_upgrade(move |socket| crate::live::handle(socket, hub, http, port, version, request))
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
fn query_encode(s: &str) -> String {
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
        nowaki_core::css::scope_css(&id, &css).0
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
    // public/ files are sent as they are (no CSS shim, no TS transform), ahead of routes.
    if matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) {
        if let Some(resp) = serve_public(&state, &path).await {
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
    let read = matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    if read && path != "/" {
        if let Some(candidate) = app_file(&state.core.root, &path) {
            return serve_file(state, candidate).await;
        }
    }
    proxy_to_sidecar(state, req).await
}

/// The app file a request path names, decoded (the renderer writes island and script URLs
/// unencoded, so the browser asks for `/islands/Cnt%20%C3%84.tsx`). None for a malformed escape,
/// a `.` / `..` / empty segment, a backslash or NUL, a missing file, a real path that leaves the
/// root (via a symlink), or a sensitive file. `root` is canonical (main.rs).
fn app_file(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = nowaki_core::public::percent_decode(url_path)?;
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

async fn proxy_to_sidecar(state: Arc<DevState>, req: Request) -> Response {
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
}
