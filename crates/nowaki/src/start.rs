//! Rust hot path for production serving. Used by `nowaki start`.
//!
//! Rust (axum) handles the HTTP edge, static files, and HTML assembly; the Node prod-sidecar
//! only renders components (pages return body + meta as JSON). Separate from the deploy adapters.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Request, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(serde::Deserialize, Default)]
struct Manifest {
    runtime: Option<String>,
    #[serde(default, rename = "routerRuntime")]
    router_runtime: Option<String>,
    #[serde(default, rename = "liveRuntime")]
    live_runtime: Option<String>,
    #[serde(default)]
    islands: HashMap<String, String>,
    #[serde(default)]
    preload: HashMap<String, Vec<String>>,
    /// Where the files above are served: `/_nowaki/`, or `<basePath>/_nowaki/`.
    #[serde(skip)]
    asset_base: String,
}

#[derive(serde::Deserialize)]
struct PageMeta {
    body: String,
    title: String,
    head: String,
    lang: String,
    /// ` name="value"…` for `<html>` / `<body>`, escaped by the runtime (document.mjs
    /// `pageMeta`); empty from runtimes older than 0.15.3.
    #[serde(default, rename = "htmlAttrs")]
    html_attrs: String,
    #[serde(default, rename = "bodyAttrs")]
    body_attrs: String,
    /// A slot on the page intercepts URLs (handler.mjs): it gets the islands runtime, and so the
    /// client router, even without islands.
    #[serde(default)]
    router: bool,
}

struct ProdState {
    client_dir: PathBuf,
    /// `/_nowaki/*` files held in memory with their `.br` / `.gz` siblings (see `load_assets`).
    assets: HashMap<String, Asset>,
    /// `dist/public/*` by URL path (see `load_public`).
    public: HashMap<String, PublicFile>,
    sidecar_port: u16,
    http: reqwest::Client,
    manifest: Manifest,
    live_hub: Arc<crate::live::LiveHub>,
    /// Shared with the sidecar's stdout reader (`NOWAKI_PURGE` lines).
    isr: Arc<IsrCache>,
    /// nowaki.config routing; `None` (no routing.json) costs nothing per request.
    front: Option<Arc<crate::front::Front>>,
    /// The last sidecar ping of `GET /__nowaki/health` and its result.
    health: Mutex<Option<(Instant, bool)>>,
}

/// In-memory ISR cache (routes with `export const revalidate = <seconds>`, stale-while-revalidate).
struct IsrCache {
    entries: Mutex<HashMap<String, Arc<CacheEntry>>>,
    inflight: Mutex<HashSet<String>>, // revalidation single-flight
    specs: Mutex<HashMap<String, VarySpec>>, // learned Vary spec per pathname
    max: usize,                       // entry cap (oldest evicted when exceeded)
    /// Bumped by every purge. A render records it before asking the sidecar, so a purge that
    /// happens while the render runs keeps its result out of the cache (see `IsrCache::insert`).
    epoch: AtomicU64,
    /// The last purges, newest last, for that check.
    purges: Mutex<VecDeque<Purge>>,
}

/// How many purges `IsrCache::purges` remembers. A render that started before the oldest one is
/// not stored (it can't be checked), which only costs a re-render.
const PURGE_LOG: usize = 64;

/// One `revalidatePath` / `revalidateTag` batch: browser paths and tags (server/revalidate.mjs).
#[derive(Default, Debug, PartialEq)]
struct Purge {
    epoch: u64,
    paths: Vec<String>,
    tags: Vec<String>,
}

impl Purge {
    fn matches(&self, path: &str, tags: &[Box<str>]) -> bool {
        self.paths.iter().any(|p| p == path)
            || tags.iter().any(|t| self.tags.iter().any(|x| **x == **t))
    }

    fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.tags.is_empty()
    }
}

/// The internal response headers of the sidecar hop: Rust consumes them, so they never reach the
/// browser, on either branch of `proxy`.
const PURGE_HEADER: &str = "x-nowaki-purge";
const TAGS_HEADER: &str = "x-nowaki-tags";
const ROUTE_HEADER: &str = "x-nowaki-route";
const INTERNAL_RESPONSE_HEADERS: [&str; 3] = [PURGE_HEADER, TAGS_HEADER, ROUTE_HEADER];

/// Page responses drop every `x-nowaki-*` header; passthrough ones keep those the browser runtime
/// reads (`x-nowaki-slot`) and drop these.
fn is_internal_response_header(name: &str) -> bool {
    name.starts_with("x-nowaki-") && INTERNAL_RESPONSE_HEADERS.contains(&name)
}

/// Percent-decodes one item of an `x-nowaki-purge` / `x-nowaki-tags` list (server/revalidate.mjs
/// `encodeEntries`); None when it isn't valid UTF-8 or has a broken escape.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The items of an encoded list, decoded; broken ones are dropped.
fn decode_list(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(',')
        .filter(|s| !s.is_empty())
        .filter_map(percent_decode)
}

/// `t:<tag>` / `p:<browser path>` entries into a purge (epoch unset).
fn decode_purge(value: &str) -> Purge {
    let mut out = Purge::default();
    for e in decode_list(value) {
        if let Some(t) = e.strip_prefix("t:") {
            if !t.is_empty() {
                out.tags.push(t.to_string());
            }
        } else if let Some(p) = e.strip_prefix("p:") {
            if p.starts_with('/') {
                out.paths.push(p.to_string());
            }
        }
    }
    out
}

/// `NOWAKI_PURGE <token> <entries>`: a revalidate call made outside a request. None for any other
/// line, including one with the wrong token (app log output can't purge).
fn purge_line(line: &str) -> Option<Purge> {
    let (token, entries) = line.strip_prefix("NOWAKI_PURGE ")?.split_once(' ')?;
    (token == crate::live::publish_token()).then(|| decode_purge(entries.trim()))
}

/// Inputs a route's render depends on (Vary). Learned from x-nowaki-vary and folded into the cache key
/// to prevent cross-user leaks on header-dependent pages and cache floods from unused queries.
#[derive(Default, Clone)]
struct VarySpec {
    query: bool,                                 // depends on the query string
    headers: std::collections::BTreeSet<String>, // request header names depended on (lowercase, stable order)
    no_cache: bool,                              // depends on all headers ("*") → uncacheable
}

struct CacheEntry {
    status: u16,
    /// The page, pre-compressed once when stored. With CSP on, every response gets a fresh nonce,
    /// so only `plain` is kept and no ETag is sent (see `isr_store`).
    body: crate::encoding::Variants,
    with_etag: bool,
    headers: Vec<(String, String)>, // response headers to restore (cookie/length headers excluded)
    stored_at: Instant,
    revalidate: Duration,
    // Request context for regenerating the same variant during background revalidation.
    refetch_path: String,                   // path(+query) sent to the sidecar
    refetch_headers: Vec<(String, String)>, // actual values of the folded-in Vary headers
    /// The browser path of the key (before `\u{1d}`): what `revalidatePath` matches.
    path: Box<str>,
    /// `export const tags` of the render (`x-nowaki-tags`): what `revalidateTag` matches.
    tags: Box<[Box<str>]>,
    /// The route pattern (`x-nowaki-route`, sent only while tracing), for a hit's span name.
    route: Option<Box<str>>,
}

impl IsrCache {
    fn new() -> Self {
        let max = std::env::var("NOWAKI_ISR_MAX")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(1024);
        Self::with_max(max)
    }

    fn with_max(max: usize) -> Self {
        IsrCache {
            entries: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashSet::new()),
            specs: Mutex::new(HashMap::new()),
            max,
            epoch: AtomicU64::new(0),
            purges: Mutex::new(VecDeque::new()),
        }
    }

    /// The epoch to pass to `insert` for a render that starts now.
    fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    /// Deletes every entry whose path or tags `purge` names (one scan: purges are rare and the
    /// map holds at most `NOWAKI_ISR_MAX` entries, so nothing is indexed on store). The next
    /// request for them is a MISS that renders fresh. Returns how many were removed.
    fn purge(&self, mut purge: Purge) -> usize {
        if purge.is_empty() {
            return 0;
        }
        // The entries lock is held across the epoch bump and the scan, and `insert` checks the log
        // under the same lock, so a render can't slip its stale result in between.
        let mut map = self.entries.lock().unwrap();
        purge.epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let before = map.len();
        map.retain(|_, e| !purge.matches(&e.path, &e.tags));
        let removed = before - map.len();
        let mut log = self.purges.lock().unwrap();
        if log.len() >= PURGE_LOG {
            log.pop_front();
        }
        log.push_back(purge);
        removed
    }

    /// Whether a purge after `epoch` names this path or one of these tags (or may have: it fell
    /// out of the log). Called with the entries lock held.
    fn purged_since(&self, epoch: u64, path: &str, tags: &[Box<str>]) -> bool {
        if self.epoch.load(Ordering::Acquire) == epoch {
            return false;
        }
        let log = self.purges.lock().unwrap();
        if log.front().is_none_or(|p| p.epoch > epoch + 1) {
            return true;
        }
        log.iter().any(|p| p.epoch > epoch && p.matches(path, tags))
    }

    /// Stores a render that started at `epoch` (`IsrCache::epoch`), unless a purge since then
    /// covers it. When over the cap, the oldest entry of the same pathname goes first (a
    /// query/header flood doesn't evict other routes).
    fn insert(&self, key: &str, entry: CacheEntry, epoch: u64) {
        let mut map = self.entries.lock().unwrap();
        if self.purged_since(epoch, &entry.path, &entry.tags) {
            return;
        }
        if map.len() >= self.max && !map.contains_key(key) {
            let path = key.split(['?', '\u{1e}', '\u{1f}']).next().unwrap_or(key);
            let victim = map
                .iter()
                .filter(|(k, _)| k.split(['?', '\u{1e}', '\u{1f}']).next() == Some(path))
                .min_by_key(|(_, e)| e.stored_at)
                .map(|(k, _)| k.clone())
                .or_else(|| {
                    map.iter()
                        .min_by_key(|(_, e)| e.stored_at)
                        .map(|(k, _)| k.clone())
                });
            if let Some(v) = victim {
                map.remove(&v);
            }
        }
        map.insert(key.to_string(), Arc::new(entry));
    }
}

/// The page's tags from `x-nowaki-tags` (none without the header).
fn tags_of(h: &reqwest::header::HeaderMap) -> Box<[Box<str>]> {
    h.get(TAGS_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| decode_list(v).map(String::into_boxed_str).collect())
        .unwrap_or_default()
}

fn route_of(h: &reqwest::header::HeaderMap) -> Option<Box<str>> {
    h.get(ROUTE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(Box::from)
}

/// Purges what a sidecar response names in `x-nowaki-purge` (a revalidate call during the request).
fn purge_from(isr: &IsrCache, h: &reqwest::header::HeaderMap) {
    if let Some(v) = h.get(PURGE_HEADER).and_then(|v| v.to_str().ok()) {
        isr.purge(decode_purge(v));
    }
}

pub async fn run(root: PathBuf, bind: crate::listen::Bind) -> Result<()> {
    let started = std::time::Instant::now();
    let client_dir = root.join("dist/client");
    if !client_dir.join("manifest.json").exists() {
        anyhow::bail!(
            "Not built yet. Run `nowaki build {}` first.",
            root.display()
        );
    }
    let entry = root.join("node_modules/@nowaki-dev/runtime/server/prod-sidecar.mjs");
    if !entry.exists() {
        anyhow::bail!(
            "Dependencies are not installed ({} not found).\n  → Run `npm install` in the app directory.",
            entry.display()
        );
    }
    // Bound before the sidecar starts, so a taken port fails right away.
    let listener = crate::listen::bind(&bind).await?;
    let local = listener.local_addr()?;

    // Read the observability settings now (the OTLP exporter task starts on this runtime).
    let obs = crate::obs::get();
    let live_hub = crate::live::LiveHub::new();
    let mut child = Command::new("node")
        .arg("--enable-source-maps")
        .arg(&entry)
        .current_dir(&root)
        .env("NOWAKI_PUBLISH_TOKEN", crate::live::publish_token())
        // The pipe stays in `child`; when this process ends (even by SIGKILL) it closes and the
        // sidecar exits (server/exit-with-parent.mjs) instead of lingering.
        .env("NOWAKI_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("failed to start prod-sidecar (node)")?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let mut sidecar_port = None;
    while let Some(line) = lines.next_line().await? {
        if let Some(rest) = line.strip_prefix("NOWAKI_START_READY ") {
            sidecar_port = Some(rest.trim().parse::<u16>().context("invalid sidecar port")?);
            break;
        }
        // Nothing is cached yet; a purge from startup code only needs to stay out of the log.
        if purge_line(&line).is_some() {
            continue;
        }
        crate::obs::sidecar_line(&line);
    }
    let sidecar_port =
        sidecar_port.ok_or_else(|| anyhow!("prod-sidecar exited without reporting READY"))?;
    let hub_for_lines = live_hub.clone();
    let isr = Arc::new(IsrCache::new());
    let isr_for_lines = isr.clone();
    tokio::spawn(async move {
        while let Ok(Some(l)) = lines.next_line().await {
            if crate::live::handle_sidecar_line(&hub_for_lines, &l) {
                continue;
            }
            match purge_line(&l) {
                Some(purge) => {
                    isr_for_lines.purge(purge);
                }
                None => crate::obs::sidecar_line(&l),
            }
        }
    });

    let front = crate::front::load(&root.join("dist/server/routing.json"))?;
    let manifest_text = std::fs::read_to_string(client_dir.join("manifest.json"))?;
    let mut manifest: Manifest = serde_json::from_str(&manifest_text).unwrap_or_default();
    manifest.asset_base = match &front {
        Some(f) => format!("{}/_nowaki/", f.base_path()),
        None => "/_nowaki/".to_string(),
    };

    let assets = load_assets(&client_dir);
    let public = load_public(&client_dir.with_file_name("public"));
    let state = Arc::new(ProdState {
        assets,
        public,
        client_dir,
        sidecar_port,
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        manifest,
        live_hub,
        isr,
        front: front.clone(),
        health: Mutex::new(None),
    });

    let warm_state = state.clone();
    let base = front.clone().filter(|f| f.has_base());
    let mut app = Router::new()
        .route("/__nowaki/live", get(live_ws))
        .route(HEALTH_PATH, get(health))
        .fallback(any(handle))
        .with_state(state);
    // Inside the security-headers layer, so a rule's header wins over a default one.
    if let Some(front) = front.filter(|f| f.has_response_layer()) {
        app = app.layer(axum::middleware::from_fn_with_state(
            front,
            crate::front::headers_layer,
        ));
    }
    let app = app
        .layer(axum::middleware::from_fn(crate::csp::layer))
        .layer(axum::middleware::map_response(crate::security_headers::add));
    let actual = local.port();
    // Also report the actual port when PORT=0 (a marker grepped by prerender / adapters / bench; keep it).
    println!("NOWAKI_START_READY {actual}");
    if obs.json {
        crate::obs::log(
            "info",
            "listening",
            &[
                ("host", local.ip().to_string().into()),
                ("port", actual.into()),
                ("ready_ms", (started.elapsed().as_millis() as u64).into()),
            ],
        );
    } else {
        crate::ui::server_banner(
            "Nowaki (production)",
            env!("CARGO_PKG_VERSION"),
            actual,
            started.elapsed().as_millis(),
            &["Rust front", "Node renderer"],
            local.ip(),
            None,
        );
    }
    if isr_warm_enabled() {
        tokio::spawn(warm_isr(warm_state, format!("127.0.0.1:{actual}")));
    }
    // The sidecar lives outside the shared state (request tasks hold that), so it is killed here on shutdown.
    tokio::select! {
        r = serve(listener, app, base) => r?,
        _ = crate::shutdown::signal() => {}
    }
    // SIGTERM first: the sidecar writes Jetstream rooms to disk before it exits.
    crate::shutdown::stop_child(&mut child, std::time::Duration::from_secs(3)).await;
    crate::obs::flush(Duration::from_secs(2)).await;
    Ok(())
}

/// Serves `app`, behind the basePath layer when there is a basePath (none otherwise: the common
/// case keeps the plain router).
async fn serve(
    listener: tokio::net::TcpListener,
    app: Router,
    base: Option<Arc<crate::front::Front>>,
) -> std::io::Result<()> {
    use tower_layer::Layer;
    match base {
        None => axum::serve(listener, app).await,
        Some(front) => {
            let app =
                axum::middleware::from_fn_with_state(front, crate::front::base_layer).layer(app);
            axum::serve(
                listener,
                axum::ServiceExt::<Request>::into_make_service(app),
            )
            .await
        }
    }
}

async fn live_ws(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    State(state): State<Arc<ProdState>>,
) -> Response {
    if !prod_ws_origin_ok(&headers) {
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    let http = state.http.clone();
    let port = state.sidecar_port;
    let hub = state.live_hub.clone();
    let request = crate::live::context_headers(&headers);
    ws.on_upgrade(move |socket| {
        crate::live::handle(socket, hub, http, port, "prod".to_string(), request)
    })
}

/// Validate the WS upgrade Origin (CSWSH guard). Prod is assumed public, so only Origin==Host is allowed
/// (no Origin = non-browser is allowed).
fn prod_ws_origin_ok(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let Some(origin_host) = origin.split("://").nth(1).map(|h| h.trim_end_matches('/')) else {
        return false;
    };
    match crate::forward::public_host(headers, crate::forward::trust_proxy()) {
        Some(host) => origin_host == host,
        None => false,
    }
}

const HEALTH_PATH: &str = "/__nowaki/health";

/// `GET /__nowaki/health`: 200 while the sidecar answers its own health path within a second, 503
/// otherwise. The result is reused for a second, so a flood of probes costs one ping per second.
/// No data in it, never cached.
async fn health(State(state): State<Arc<ProdState>>) -> Response {
    let cached = *state.health.lock().unwrap();
    let ok = match cached {
        Some((at, ok)) if at.elapsed() < Duration::from_secs(1) => ok,
        _ => {
            let url = format!("http://127.0.0.1:{}{HEALTH_PATH}", state.sidecar_port);
            let ok = matches!(
                state.http.get(&url).timeout(Duration::from_secs(1)).send().await,
                Ok(r) if r.status().is_success()
            );
            *state.health.lock().unwrap() = Some((Instant::now(), ok));
            ok
        }
    };
    let (status, body) = if ok {
        (StatusCode::OK, r#"{"status":"ok"}"#)
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"status":"unavailable"}"#,
        )
    };
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// Sent by the client router for an intercepting route's fragment (handler.mjs `renderIntercept`).
const INTERCEPT_HEADER: &str = "x-nowaki-intercept";

/// Whether the ISR cache may answer (and store) a request: GETs, except the client router asking for
/// an intercepting slot's fragment. The ISR key is the path, so a cached full page must not answer
/// that request, and the fragment must not be stored.
fn isr_eligible(method: &Method, headers: &axum::http::HeaderMap) -> bool {
    *method == Method::GET && !headers.contains_key(INTERCEPT_HEADER)
}

async fn handle(State(state): State<Arc<ProdState>>, req: Request) -> Response {
    let obs = crate::obs::get();
    if !obs.active() {
        return route(state, req).await;
    }
    observed(obs, state, req).await
}

const SERVER_TIMING: &str = "server-timing";

/// The route pattern the sidecar matched (`x-nowaki-route`), from `proxy` to `observed`.
#[derive(Clone)]
struct RouteName(String);

/// The request's SERVER span, from `observed` to `proxy` (the parent of its CLIENT span).
#[derive(Clone)]
struct ServerSpan(crate::obs::Span);

/// A request with Server-Timing, JSON logs or tracing on: a SERVER span around it (an incoming
/// `traceparent` is its parent), `isr` and `total` appended to Server-Timing, and an access log line.
async fn observed(
    obs: &'static crate::obs::Obs,
    state: Arc<ProdState>,
    mut req: Request,
) -> Response {
    use crate::obs::{Attr, Kind};
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let span = obs.otel().map(|o| {
        let parent = req
            .headers()
            .get("traceparent")
            .and_then(|v| v.to_str().ok())
            .and_then(crate::obs::parse_traceparent);
        o.root(method.as_str().to_string(), Kind::Server, parent)
    });
    if let Some(s) = &span {
        req.extensions_mut().insert(ServerSpan(s.clone()));
    }
    let mut resp = route(state, req).await;
    let isr = match resp.headers().get("x-nowaki-cache").map(|v| v.as_bytes()) {
        Some(b"HIT") => Some("HIT"),
        Some(b"STALE") => Some("STALE"),
        Some(b"MISS") => Some("MISS"),
        _ => None,
    };
    if obs.timing {
        let value = crate::obs::server_timing(
            resp.headers()
                .get(SERVER_TIMING)
                .and_then(|v| v.to_str().ok()),
            isr,
            started.elapsed(),
        );
        if let Ok(v) = header::HeaderValue::from_str(&value) {
            resp.headers_mut().insert(SERVER_TIMING, v);
        }
    }
    let route = resp.extensions_mut().remove::<RouteName>();
    let status = resp.status().as_u16();
    let span = span.map(|mut s| {
        if let Some(r) = &route {
            s.name = format!("{method} {}", r.0);
        }
        s.attr("http.request.method", Attr::Str(method.to_string()));
        s.attr("url.path", Attr::Str(path.clone()));
        if let Some(r) = route {
            s.attr("http.route", Attr::Str(r.0));
        }
        s.attr("http.response.status_code", Attr::Int(i64::from(status)));
        if let Some(i) = isr {
            s.attr("nowaki.isr", Attr::Str(i.to_string()));
        }
        s.error = status >= 500;
        s
    });
    if obs.json {
        crate::obs::access_log(
            method.as_str(),
            &path,
            status,
            started.elapsed(),
            isr,
            span.as_ref(),
        );
    }
    if let (Some(o), Some(s)) = (obs.otel(), span) {
        o.end(s);
    }
    resp
}

async fn route(state: Arc<ProdState>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    if crate::forward::is_internal_path(&path) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    // basePath, trailingSlash, redirects, rewrites: a response, or the path to route by.
    let route_path = match &state.front {
        None => None,
        Some(front) => match front.apply(req.method(), req.uri()) {
            crate::front::Step::Respond(resp) => return resp,
            crate::front::Step::Continue(route_path) => route_path,
        },
    };
    let lookup = route_path.as_deref().unwrap_or(&path);
    // Rust serves static assets directly (high-volume hot path).
    // HEAD mirrors GET everywhere below; axum drops the body.
    if matches!(*req.method(), Method::GET | Method::HEAD) && lookup.starts_with("/_nowaki/") {
        return serve_static(&state, lookup, req.headers()).await;
    }
    // public/ files win over routes at the same path (a file is an exact match).
    if matches!(*req.method(), Method::GET | Method::HEAD) {
        if let Some(file) = state.public.get(lookup) {
            return serve_public(file, req.headers()).await;
        }
    }
    if isr_eligible(req.method(), req.headers()) {
        let pathname = isr_path(&path, route_path.as_deref());
        let query = req.uri().query().map(|q| q.to_string());
        let spec = state
            .isr
            .specs
            .lock()
            .unwrap()
            .get(pathname.as_ref())
            .cloned()
            .unwrap_or_default();
        if !spec.no_cache {
            if let Some(key) = isr_key(&pathname, query.as_deref(), req.headers(), &spec) {
                if let Some(resp) = isr_lookup(&state, &key, req.headers()) {
                    return resp;
                }
            }
        }
        return proxy(state, req, true, route_path).await;
    }
    proxy(state, req, false, route_path).await
}

/// The ISR cache's path for a request: the browser's path, plus the route path when a rewrite or
/// basePath made them differ (a cached render belongs to the route it was rendered from).
fn isr_path<'a>(pathname: &'a str, route_path: Option<&str>) -> std::borrow::Cow<'a, str> {
    match route_path {
        None => std::borrow::Cow::Borrowed(pathname),
        Some(r) => std::borrow::Cow::Owned(format!("{pathname}\u{1d}{r}")),
    }
}

/// Header values are folded in the BTreeSet's stable order. `None` means the request must bypass
/// the cache (no lookup, no store): a varied header that repeats, or whose value isn't visible
/// ASCII (plus SP/HTAB), can't be keyed faithfully. The sidecar sees every value (Node joins
/// repeats and keeps obs-text bytes), so keying on a lossy view of them would store one visitor's
/// render under another visitor's key. An absent header and an empty one get different keys, since
/// a loader can tell them apart.
fn isr_key(
    pathname: &str,
    query: Option<&str>,
    headers: &axum::http::HeaderMap,
    spec: &VarySpec,
) -> Option<String> {
    let mut k = String::from(pathname);
    if spec.query {
        if let Some(q) = query {
            k.push('?');
            k.push_str(q);
        }
    }
    // `ctx.url.origin` (and canonical / og:url without a `site`) comes from the public host, so a
    // render for one host must not be served to another.
    let trust = crate::forward::trust_proxy();
    if let Some(host) = crate::forward::public_host(headers, trust) {
        if !host.bytes().all(|b| b.is_ascii_graphic()) {
            return None;
        }
        k.push('\u{1e}');
        k.push_str(crate::forward::public_proto(headers, trust));
        k.push_str("://");
        k.push_str(&host);
    }
    for name in &spec.headers {
        k.push('\u{1f}'); // Unit Separator: header boundary (to_str() rejects control chars in values)
        k.push_str(name);
        let mut values = headers.get_all(name.as_str()).iter();
        let Some(first) = values.next() else {
            continue; // absent: name only, no '='
        };
        if values.next().is_some() {
            return None;
        }
        k.push('=');
        k.push_str(first.to_str().ok()?);
    }
    Some(k)
}

fn isr_lookup(state: &Arc<ProdState>, key: &str, req: &axum::http::HeaderMap) -> Option<Response> {
    let entry = state.isr.entries.lock().unwrap().get(key).cloned()?;
    let stale = entry.stored_at.elapsed() >= entry.revalidate;
    if stale {
        spawn_revalidate(state.clone(), key.to_string());
    }
    Some(cached_response(
        &entry,
        if stale { "STALE" } else { "HIT" },
        req,
    ))
}

fn cached_response(
    entry: &CacheEntry,
    cache_status: &str,
    req: &axum::http::HeaderMap,
) -> Response {
    let mut builder = Response::builder()
        .status(entry.status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("x-nowaki-cache", cache_status);
    for (n, v) in &entry.headers {
        builder = builder.header(n.as_str(), v.as_str());
    }
    let mut resp = if entry.with_etag {
        entry.body.respond(req, builder, entry.status)
    } else {
        builder
            .body(Body::from(entry.body.plain.clone()))
            .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
    };
    if let Some(r) = &entry.route {
        resp.extensions_mut().insert(RouteName(r.to_string()));
    }
    resp
}

fn isr_warm_enabled() -> bool {
    !matches!(
        std::env::var("NOWAKI_ISR_WARM")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("0" | "off" | "false" | "no")
    )
}

/// Renders every ISR page once in the background right after startup (`NOWAKI_ISR_WARM=0` turns
/// it off), so the first visitor already gets a cached page from Rust. Each page goes through the
/// normal request path with no cookies, so it is stored exactly as an anonymous visit would be:
/// pages that vary on a header are keyed by that header's absence (an anonymous visitor), never
/// serving someone who sends it. Two at a time, to leave the renderer free for real traffic.
async fn warm_isr(state: Arc<ProdState>, host: String) {
    use futures_util::StreamExt;
    let started = Instant::now();
    let url = format!(
        "http://127.0.0.1:{}/__nowaki/isr-urls?max={}",
        state.sidecar_port, state.isr.max
    );
    let urls: Vec<String> = match state.http.get(&url).send().await {
        Ok(r) if r.status().is_success() => r
            .bytes()
            .await
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default(),
        _ => return,
    };
    if urls.is_empty() {
        return;
    }
    let total = urls.len();
    let warmed = futures_util::stream::iter(urls)
        .map(|path| {
            let state = state.clone();
            let host = host.clone();
            async move {
                // The URLs are route paths; warm the URL a browser asks for (basePath, trailing slash).
                let uri = match &state.front {
                    Some(front) => front.browser_path(&path),
                    None => path,
                };
                let Ok(req) = Request::builder()
                    .method(Method::GET)
                    .uri(&uri)
                    .header(header::HOST, host)
                    .body(Body::empty())
                else {
                    return false;
                };
                let route_path = match &state.front {
                    None => None,
                    Some(front) => match front.apply(req.method(), req.uri()) {
                        crate::front::Step::Respond(_) => return false,
                        crate::front::Step::Continue(route_path) => route_path,
                    },
                };
                let resp = proxy(state, req, true, route_path).await;
                // MISS = rendered and stored (a Set-Cookie response is served but never stored).
                resp.headers().get("x-nowaki-cache").is_some()
                    && !resp.headers().contains_key(header::SET_COOKIE)
            }
        })
        .buffer_unordered(2)
        .filter(|ok| std::future::ready(*ok))
        .count()
        .await;
    println!(
        "[nowaki] ISR warm-up: {warmed} of {total} pages cached in {} ms",
        started.elapsed().as_millis()
    );
}

/// Single-flight: only one revalidation runs per key.
fn spawn_revalidate(state: Arc<ProdState>, key: String) {
    {
        let mut inflight = state.isr.inflight.lock().unwrap();
        if !inflight.insert(key.clone()) {
            return;
        }
    }
    tokio::spawn(async move {
        let _ = revalidate_entry(&state, &key).await;
        state.isr.inflight.lock().unwrap().remove(&key);
    });
}

/// Replays the stored variant (path+query and Vary header values), not a clean GET.
async fn revalidate_entry(state: &Arc<ProdState>, key: &str) -> Option<()> {
    let epoch = state.isr.epoch();
    let (refetch_path, refetch_headers, path) = {
        let e = state.isr.entries.lock().unwrap().get(key).cloned()?;
        (
            e.refetch_path.clone(),
            e.refetch_headers.clone(),
            e.path.clone(),
        )
    };
    let url = format!("http://127.0.0.1:{}{}", state.sidecar_port, refetch_path);
    let mut req = state.http.get(&url);
    for (n, v) in &refetch_headers {
        req = req.header(n, v);
    }
    let resp = req.send().await.ok()?;
    let entry = page_to_entry(state, resp, refetch_path, refetch_headers, path).await?;
    isr_store(state, key, entry, epoch);
    Some(())
}

/// Conditions: 200 / x-nowaki-page / x-nowaki-revalidate>0 / no Set-Cookie (per-user excluded).
async fn page_to_entry(
    state: &ProdState,
    resp: reqwest::Response,
    refetch_path: String,
    refetch_headers: Vec<(String, String)>,
    path: Box<str>,
) -> Option<CacheEntry> {
    if resp.status() != StatusCode::OK {
        return None;
    }
    let h = resp.headers();
    if !h.contains_key("x-nowaki-page") || h.contains_key(header::SET_COOKIE) {
        return None;
    }
    let secs = isr_secs_of(h)?;
    let kept = kept_headers(h);
    let tags = tags_of(h);
    let route = route_of(h);
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.ok()?;
    let meta: PageMeta = serde_json::from_slice(&bytes).ok()?;
    let html = assemble(&state.manifest, &meta);
    Some(CacheEntry {
        status,
        body: crate::encoding::Variants::new(html.into(), None, None),
        with_etag: false,
        headers: kept,
        stored_at: Instant::now(),
        revalidate: Duration::from_secs(secs),
        refetch_path,
        refetch_headers,
        path,
        tags,
        route,
    })
}

fn isr_secs_of(h: &reqwest::header::HeaderMap) -> Option<u64> {
    h.get("x-nowaki-revalidate")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
}

/// Set-Cookie is never restored from the shared cache, and neither is the render's Server-Timing
/// (a hit gets its own, from `observed`).
fn kept_headers(h: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (name, value) in h.iter() {
        let n = name.as_str();
        if n.starts_with("x-nowaki-")
            || n == SERVER_TIMING
            || name == header::CONTENT_TYPE
            || name == header::CONTENT_LENGTH
            || name == header::TRANSFER_ENCODING
            || name == header::SET_COOKIE
        {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out.push((n.to_string(), v.to_string()));
        }
    }
    out
}

/// Learn the per-pathname spec from x-nowaki-vary, then store. `"*"` is uncacheable, to be safe.
#[allow(clippy::too_many_arguments)]
fn maybe_store(
    state: &Arc<ProdState>,
    pathname: &str,
    route_path: Option<&str>,
    query: Option<&str>,
    req_headers: &axum::http::HeaderMap,
    resp_headers: &reqwest::header::HeaderMap,
    secs: u64,
    status: u16,
    html: &str,
    epoch: u64,
) {
    let vary_raw = resp_headers
        .get("x-nowaki-vary")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let vary_query = resp_headers
        .get("x-nowaki-vary-query")
        .and_then(|v| v.to_str().ok())
        == Some("1");
    let names: Vec<String> = vary_raw
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let key_path = isr_path(pathname, route_path);
    let spec = {
        let mut specs = state.isr.specs.lock().unwrap();
        let spec = specs.entry(key_path.to_string()).or_default();
        if names.iter().any(|n| n == "*") {
            spec.no_cache = true;
            return;
        }
        spec.query |= vary_query;
        for n in names {
            spec.headers.insert(n);
        }
        spec.clone()
    };

    // A varied header that repeats or isn't visible ASCII: this render can't be keyed, don't store it.
    let Some(key) = isr_key(&key_path, query, req_headers, &spec) else {
        return;
    };
    let refetch_path = if spec.query {
        match query {
            Some(q) => format!("{pathname}?{q}"),
            None => pathname.to_string(),
        }
    } else {
        pathname.to_string()
    };
    // isr_key returned Some, so each varied header is absent or a single visible-ASCII value:
    // replaying these reproduces exactly the request the key describes.
    let mut refetch_headers: Vec<(String, String)> = spec
        .headers
        .iter()
        .filter_map(|n| {
            req_headers
                .get(n.as_str())
                .and_then(|v| v.to_str().ok())
                .map(|v| (n.clone(), v.to_string()))
        })
        .collect();
    refetch_headers.extend(public_origin_headers(req_headers));
    if let Some(r) = route_path {
        refetch_headers.push((crate::front::ROUTE_PATH_HEADER.to_string(), r.to_string()));
    }

    isr_store(
        state,
        &key,
        CacheEntry {
            status,
            body: crate::encoding::Variants::new(html.to_string().into(), None, None),
            with_etag: false,
            headers: kept_headers(resp_headers),
            stored_at: Instant::now(),
            revalidate: Duration::from_secs(secs),
            refetch_path,
            refetch_headers,
            path: pathname.into(),
            tags: tags_of(resp_headers),
            route: route_of(resp_headers),
        },
        epoch,
    );
}

/// The canonical `x-forwarded-host` / `-proto` that `forward::apply` sends, for an ISR refetch to
/// render with the same public origin as the request it replays.
fn public_origin_headers(headers: &axum::http::HeaderMap) -> Vec<(String, String)> {
    let trust = crate::forward::trust_proxy();
    let mut out = Vec::new();
    if let Some(host) = crate::forward::public_host(headers, trust) {
        out.push(("x-forwarded-host".to_string(), host));
    }
    out.push((
        "x-forwarded-proto".to_string(),
        crate::forward::public_proto(headers, trust).to_string(),
    ));
    out
}

/// Stores a render that started at `epoch` (see `IsrCache::insert`).
fn isr_store(state: &ProdState, key: &str, mut entry: CacheEntry, epoch: u64) {
    // Compress and tag once here, outside the lock. Not with CSP: the CSP layer rewrites each
    // HTML response with a new nonce, so a compressed body or a 304 would carry a stale one.
    if crate::csp::mode() == crate::csp::Mode::Off {
        entry.body = crate::encoding::Variants::compressed(entry.body.plain.clone());
        entry.with_etag = true;
    }
    state.isr.insert(key, entry, epoch);
}

/// A `/_nowaki/*` file in memory. Names are content-hashed, so they never change while running.
struct Asset {
    content_type: &'static str,
    body: crate::encoding::Variants,
}

/// Files above this stay on disk and are read per request, uncompressed.
const ASSET_MEMORY_MAX: u64 = 8 * 1024 * 1024;

/// Loads `dist/client` (flat) into memory, pairing each file with the `.br` / `.gz` siblings that
/// `nowaki build` wrote.
fn load_assets(client_dir: &std::path::Path) -> HashMap<String, Asset> {
    let mut out = HashMap::new();
    let Ok(dir) = std::fs::read_dir(client_dir) else {
        return out;
    };
    for entry in dir.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.ends_with(".gz")
            || name.ends_with(".br")
            || asset_name(&format!("/_nowaki/{name}")).is_none()
        {
            continue;
        }
        let path = entry.path();
        if !entry
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() <= ASSET_MEMORY_MAX)
        {
            continue;
        }
        let Ok(plain) = std::fs::read(&path) else {
            continue;
        };
        let sibling = |ext: &str| {
            std::fs::read(client_dir.join(format!("{name}.{ext}")))
                .ok()
                .map(axum::body::Bytes::from)
        };
        let body = crate::encoding::Variants::new(plain.into(), sibling("gz"), sibling("br"));
        out.insert(
            name.clone(),
            Asset {
                content_type: content_type(&name),
                body,
            },
        );
    }
    out
}

/// A `dist/public/*` file. Read from disk on each request (public/ can hold large media); the
/// index is built once at startup, so a miss costs a map lookup and nothing else.
struct PublicFile {
    path: PathBuf,
    content_type: &'static str,
    /// Weak ETag from size and mtime: the files are never rewritten while `nowaki start` runs.
    etag: String,
}

/// Keyed by the URL path as requests send it: file names are percent-encoded the way a browser
/// would (`/a b.txt` → `/a%20b.txt`), and the decoded form is kept too for clients that don't.
fn load_public(dir: &Path) -> HashMap<String, PublicFile> {
    let mut out = HashMap::new();
    for (url, path) in nowaki_core::public::list(dir).unwrap_or_default() {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let encoded = url_encode_path(&url);
        let content_type = nowaki_core::public::content_type(&url);
        let file = || PublicFile {
            path: path.clone(),
            content_type,
            etag: format!("W/\"{:x}-{:x}\"", meta.len(), mtime),
        };
        if encoded != url {
            out.insert(encoded, file());
        }
        out.insert(url, file());
    }
    out
}

/// Percent-encodes what a browser would in a path: everything but unreserved characters, `/`,
/// and the sub-delims that are safe in a path segment.
fn url_encode_path(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for b in p.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~!$&'()*+,;=:@".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Whether a public file may carry its `W/"size-mtime"` ETag. Not an HTML file under CSP: the CSP
/// layer stamps each response with a new nonce, so the body changes while the file doesn't, and a
/// 304 would pair the cached body (old nonce) with a new policy.
fn public_etag(content_type: &str, csp: crate::csp::Mode) -> bool {
    csp == crate::csp::Mode::Off || !content_type.starts_with("text/html")
}

/// `no-cache` with an ETag: public/ names aren't hashed, so a browser revalidates each use and
/// gets a 304 while the file is unchanged.
async fn serve_public(file: &PublicFile, req: &axum::http::HeaderMap) -> Response {
    let etag = public_etag(file.content_type, crate::csp::mode());
    let not_modified = etag
        && req
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',')
                    .any(|t| t.trim() == file.etag || t.trim() == "*")
            });
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, file.content_type)
        .header(header::CACHE_CONTROL, "public, no-cache");
    if etag {
        builder = builder.header(header::ETAG, &file.etag);
    }
    if not_modified {
        return builder
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::NOT_MODIFIED.into_response());
    }
    match tokio::fs::read(&file.path).await {
        Ok(bytes) => builder
            .body(Body::from(bytes))
            .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn serve_static(state: &ProdState, path: &str, req: &axum::http::HeaderMap) -> Response {
    let Some(name) = asset_name(path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if let Some(asset) = state.assets.get(name) {
        let builder = Response::builder()
            .header(header::CONTENT_TYPE, asset.content_type)
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
        return asset.body.respond(req, builder, 200);
    }
    let file = state.client_dir.join(name);
    match tokio::fs::read(&file).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, content_type(name)),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn proxy(
    state: Arc<ProdState>,
    req: Request,
    cacheable: bool,
    route_path: Option<String>,
) -> Response {
    let pathname = req.uri().path().to_string();
    let query = req.uri().query().map(|q| q.to_string());
    let path_q = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("http://127.0.0.1:{}{}", state.sidecar_port, path_q);
    let method = req.method().clone();
    let headers = req.headers().clone();

    if let Some(rejected) = crate::form_body::reject_before_read(&headers) {
        return rejected.into_response();
    }

    // Only set by `observed` (tracing on): the CLIENT span of the sidecar hop goes under it.
    let client_span = req.extensions().get::<ServerSpan>().and_then(|s| {
        let otel = crate::obs::get().otel()?;
        let mut c = otel.child(&s.0, method.as_str().to_string(), crate::obs::Kind::Client);
        c.attr(
            "server.port",
            crate::obs::Attr::Int(i64::from(state.sidecar_port)),
        );
        Some((otel, c))
    });
    let proxy_limit = crate::form_body::proxy_body_limit();
    let body = match axum::body::to_bytes(req.into_body(), proxy_limit).await {
        Ok(b) => b,
        Err(err) => {
            let (status, body) = crate::form_body::proxy_body_to_bytes_error(&err);
            return (status, body).into_response();
        }
    };

    let mut builder = state.http.request(method, &url).body(body.to_vec());
    builder = crate::forward::apply_traced(
        builder,
        &headers,
        crate::forward::trust_proxy(),
        client_span.as_ref().map(|(_, c)| c.traceparent()),
    );
    // Set after forward::apply, which drops a client's own value of this header.
    if let Some(r) = &route_path {
        builder = builder.header(crate::front::ROUTE_PATH_HEADER, r);
    }
    // Before the render starts: a purge that lands while it runs keeps its result out of the cache.
    let epoch = if cacheable { state.isr.epoch() } else { 0 };

    let sent = builder.send().await;
    if let Some((otel, mut c)) = client_span {
        match &sent {
            Ok(r) => {
                let status = r.status().as_u16();
                c.attr(
                    "http.response.status_code",
                    crate::obs::Attr::Int(i64::from(status)),
                );
                c.error = status >= 500;
            }
            Err(_) => c.error = true,
        }
        otel.end(c);
    }
    let resp = match sent {
        Ok(r) => r,
        Err(err) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("failed to connect to prod-sidecar: {err}"),
            )
                .into_response()
        }
    };

    let status = resp.status();
    let is_page = resp.headers().get("x-nowaki-page").is_some();
    let resp_headers = resp.headers().clone();
    // A revalidate call during this request (an action, API route, server function): purged
    // before the response goes out, so whatever the browser asks for next renders fresh.
    purge_from(&state.isr, &resp_headers);
    // Sent only while tracing (prod-sidecar.mjs); `observed` names the SERVER span with it.
    let route_name = route_of(&resp_headers).map(|r| RouteName(r.into()));

    if !is_page {
        // Pass through as the sidecar writes it (API, redirect, file stream, streaming SSR,
        // built-in 404/500): the first bytes go out before the last are rendered.
        let mut builder = Response::builder().status(status.as_u16());
        for (name, value) in resp_headers.iter() {
            if name != header::TRANSFER_ENCODING
                && name != header::CONTENT_LENGTH
                && !is_internal_response_header(name.as_str())
            {
                builder = builder.header(name, value);
            }
        }
        let mut out = builder
            .body(Body::from_stream(resp.bytes_stream()))
            .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response());
        if let Some(r) = route_name {
            out.extensions_mut().insert(r);
        }
        return out;
    }
    // Pages come back as JSON (body + meta) for Rust to assemble, so they are read whole.
    let bytes = resp.bytes().await.unwrap_or_default();

    {
        let html = match serde_json::from_slice::<PageMeta>(&bytes) {
            Ok(meta) => assemble(&state.manifest, &meta),
            Err(_) => String::from_utf8_lossy(&bytes).to_string(),
        };
        let isr_secs = if cacheable && status == StatusCode::OK {
            isr_secs_of(&resp_headers)
        } else {
            None
        };
        let mut builder = Response::builder()
            .status(status.as_u16())
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8");
        if isr_secs.is_some() {
            builder = builder.header("x-nowaki-cache", "MISS");
        }
        for (name, value) in resp_headers.iter() {
            let n = name.as_str();
            if n.starts_with("x-nowaki-")
                || name == header::CONTENT_TYPE
                || name == header::CONTENT_LENGTH
                || name == header::TRANSFER_ENCODING
            {
                continue;
            }
            builder = builder.header(name, value);
        }
        // Per-user responses (with Set-Cookie) never go into the shared cache.
        if let Some(secs) = isr_secs {
            if !resp_headers.contains_key(header::SET_COOKIE) {
                maybe_store(
                    &state,
                    &pathname,
                    route_path.as_deref(),
                    query.as_deref(),
                    &headers,
                    &resp_headers,
                    secs,
                    status.as_u16(),
                    &html,
                    epoch,
                );
            }
        }
        let mut out = builder
            .body(Body::from(html))
            .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response());
        if let Some(r) = route_name {
            out.extensions_mut().insert(r);
        }
        out
    }
}

/// Rust port of prodDocument (JS). Islands are picked from <nowaki-island name="..."> in the body.
fn assemble(manifest: &Manifest, meta: &PageMeta) -> String {
    let base = &manifest.asset_base;
    let island_names = scan_island_names(&meta.body);
    let has_islands = (!island_names.is_empty() || meta.router) && manifest.runtime.is_some();

    let mut preload_files: Vec<String> = Vec::new();
    if has_islands {
        let runtime = manifest.runtime.clone().unwrap();
        let mut entry_chunks = vec![runtime];
        for n in &island_names {
            if let Some(f) = manifest.islands.get(n) {
                entry_chunks.push(f.clone());
            }
        }
        let mut seen = HashSet::new();
        for chunk in entry_chunks {
            if seen.insert(chunk.clone()) {
                preload_files.push(chunk.clone());
            }
            if let Some(deps) = manifest.preload.get(&chunk) {
                for dep in deps {
                    if seen.insert(dep.clone()) {
                        preload_files.push(dep.clone());
                    }
                }
            }
        }
    }
    let preload = preload_files
        .iter()
        .map(|f| format!("<link rel=\"modulepreload\" href=\"{base}{f}\" />"))
        .collect::<Vec<_>>()
        .join("\n");
    let runtime_script = if has_islands {
        // Put the lazy router chunk's URL in data-router (islands.js imports it when idle).
        let data_router = match &manifest.router_runtime {
            Some(r) => format!(" data-router=\"{base}{r}\""),
            None => String::new(),
        };
        format!(
            "<script id=\"nowaki-runtime\" type=\"module\" src=\"{base}{}\"{data_router}></script>",
            manifest.runtime.as_ref().unwrap()
        )
    } else {
        String::new()
    };
    let live_script = if meta.body.contains("<nowaki-live") {
        match &manifest.live_runtime {
            Some(f) => {
                format!("<script id=\"nowaki-live\" type=\"module\" src=\"{base}{f}\"></script>")
            }
            None => String::new(),
        }
    } else {
        String::new()
    };

    format!(
        "<!DOCTYPE html>\n<html lang=\"{lang}\"{html_attrs}>\n<head>\n<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n<title>{title}</title>\n<meta name=\"nowaki-head\" content=\"start\" />\n{preload}\n{head}\n<meta name=\"nowaki-head\" content=\"end\" />\n</head>\n<body{body_attrs}>\n{body}\n{runtime_script}\n{live_script}\n</body>\n</html>",
        lang = escape_html(&meta.lang),
        html_attrs = meta.html_attrs,
        body_attrs = meta.body_attrs,
        title = escape_html(&meta.title),
        head = meta.head,
        body = meta.body,
    )
}

fn scan_island_names(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let needle = "<nowaki-island name=\"";
    let mut rest = body;
    while let Some(i) = rest.find(needle) {
        let after = &rest[i + needle.len()..];
        if let Some(end) = after.find('"') {
            out.push(after[..end].to_string());
            rest = &after[end..];
        } else {
            break;
        }
    }
    out
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The file name a `/_nowaki/<name>` request may serve from dist/client, or None.
/// Build output names are only [A-Za-z0-9._-], so anything else is rejected rather than
/// trusting the OS to split it: on Windows `\`, `C:` and `..` would escape dist/client.
fn asset_name(path: &str) -> Option<&str> {
    let name = path.strip_prefix("/_nowaki/")?;
    let ok = !name.is_empty()
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    ok.then_some(name)
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_name_accepts_build_output_names() {
        assert_eq!(
            asset_name("/_nowaki/islands.ed8bc7e5.js"),
            Some("islands.ed8bc7e5.js")
        );
        assert_eq!(
            asset_name("/_nowaki/Badge.css.1a2b3c4d.js"),
            Some("Badge.css.1a2b3c4d.js")
        );
        assert_eq!(
            asset_name("/_nowaki/font_x-1.02b54027.woff2"),
            Some("font_x-1.02b54027.woff2")
        );
    }

    #[test]
    fn asset_name_rejects_traversal_on_every_os() {
        for path in [
            "/_nowaki/../../Cargo.toml",
            "/_nowaki/foo/../../etc/passwd",
            "/_nowaki/..\\..\\.env",
            "/_nowaki/C:\\Windows\\win.ini",
            "/_nowaki/C:win.ini",
            "/_nowaki/%2e%2e%2f.env",
            "/_nowaki/.env",
            "/_nowaki/..",
            "/_nowaki/",
            "/other/islands.js",
        ] {
            assert_eq!(asset_name(path), None, "{path} must be rejected");
        }
    }

    fn vary_on(names: &[&str]) -> VarySpec {
        VarySpec {
            headers: names.iter().map(|n| n.to_string()).collect(),
            ..VarySpec::default()
        }
    }

    fn header_map(pairs: &[(&str, &[u8])]) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        for (n, v) in pairs {
            h.append(
                axum::http::HeaderName::from_bytes(n.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_bytes(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn isr_key_bypasses_repeated_varied_headers() {
        let spec = vary_on(&["accept-language", "cookie"]);
        let anon = isr_key("/p", None, &header_map(&[]), &spec);
        assert!(anon.is_some());
        // `Cookie:` + `Cookie: user=attacker` renders for user=attacker; it used to share the
        // key of an anonymous visitor. It must not be cached at all.
        let dup = header_map(&[("cookie", b""), ("cookie", b"user=attacker")]);
        assert_eq!(isr_key("/p", None, &dup, &spec), None);
        let dup_lang = header_map(&[("accept-language", b""), ("accept-language", b"xx-EVIL")]);
        assert_eq!(isr_key("/p", None, &dup_lang, &spec), None);
        // A repeated header the page does not vary on doesn't matter.
        let other = header_map(&[("x-a", b"1"), ("x-a", b"2")]);
        assert_eq!(isr_key("/p", None, &other, &spec), anon);
    }

    #[test]
    fn isr_key_bypasses_non_visible_ascii_values() {
        let spec = vary_on(&["cookie"]);
        let obs = header_map(&[("cookie", b"user=obs\xff\xfe")]);
        assert_eq!(isr_key("/p", None, &obs, &spec), None);
        let anon = isr_key("/p", None, &header_map(&[]), &spec);
        assert!(anon.is_some());
        // Absent and empty differ (a loader can tell `undefined` from `""`).
        let empty = header_map(&[("cookie", b"")]);
        assert_ne!(isr_key("/p", None, &empty, &spec), anon);
    }

    #[test]
    fn isr_key_keeps_users_apart() {
        let spec = vary_on(&["cookie"]);
        let a = isr_key("/p", None, &header_map(&[("cookie", b"user=a")]), &spec);
        let b = isr_key("/p", None, &header_map(&[("cookie", b"user=b")]), &spec);
        let anon = isr_key("/p", None, &header_map(&[]), &spec);
        assert!(a.is_some() && b.is_some());
        assert_ne!(a, b);
        assert_ne!(a, anon);
        assert_eq!(
            isr_key("/p", None, &header_map(&[("cookie", b"user=a")]), &spec),
            a
        );
    }

    #[test]
    fn isr_key_keeps_hosts_apart() {
        // ctx.url.origin is the public host, so one host's render must not reach another.
        let spec = VarySpec::default();
        let a = isr_key("/p", None, &header_map(&[("host", b"a.example")]), &spec);
        let b = isr_key("/p", None, &header_map(&[("host", b"b.example")]), &spec);
        assert!(a.is_some() && b.is_some());
        assert_ne!(a, b);
        let refetch = public_origin_headers(&header_map(&[("host", b"a.example")]));
        assert!(refetch.contains(&("x-forwarded-host".into(), "a.example".into())));
        assert!(refetch.contains(&("x-forwarded-proto".into(), "http".into())));
    }

    #[test]
    fn public_html_has_no_etag_under_csp() {
        use crate::csp::Mode;
        assert!(public_etag("text/html; charset=utf-8", Mode::Off));
        assert!(!public_etag("text/html; charset=utf-8", Mode::Enforce));
        assert!(!public_etag("text/html; charset=utf-8", Mode::ReportOnly));
        assert!(public_etag("text/css; charset=utf-8", Mode::Enforce));
    }

    #[test]
    fn intercept_requests_skip_the_isr_cache() {
        assert!(isr_eligible(&Method::GET, &header_map(&[])));
        assert!(!isr_eligible(&Method::POST, &header_map(&[])));
        assert!(!isr_eligible(
            &Method::GET,
            &header_map(&[("x-nowaki-intercept", b"/@modal")])
        ));
    }

    fn entry(path: &str, tags: &[&str]) -> CacheEntry {
        CacheEntry {
            status: 200,
            body: crate::encoding::Variants::new(axum::body::Bytes::from_static(b"x"), None, None),
            with_etag: false,
            headers: Vec::new(),
            stored_at: Instant::now(),
            revalidate: Duration::from_secs(60),
            refetch_path: path.to_string(),
            refetch_headers: Vec::new(),
            path: path.into(),
            tags: tags.iter().map(|t| Box::<str>::from(*t)).collect(),
            route: None,
        }
    }

    fn keys(cache: &IsrCache) -> Vec<String> {
        let mut k: Vec<String> = cache.entries.lock().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    fn purge_of(paths: &[&str], tags: &[&str]) -> Purge {
        Purge {
            epoch: 0,
            paths: paths.iter().map(|p| p.to_string()).collect(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
        }
    }

    #[test]
    fn purge_fixture_matches_the_js_encoding() {
        let fx: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/purge-cases.json")).unwrap();
        let strings = |v: &serde_json::Value| -> Vec<String> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect()
        };
        for c in fx["encode"]
            .as_array()
            .unwrap()
            .iter()
            .chain(fx["broken"].as_array().unwrap())
        {
            let header = c["header"].as_str().unwrap();
            let got: Vec<String> = decode_list(header).collect();
            assert_eq!(got, strings(&c["entries"]), "decode {header}");
        }
        for c in fx["purge"].as_array().unwrap() {
            let header = c["header"].as_str().unwrap();
            let got = decode_purge(header);
            assert_eq!(got.paths, strings(&c["paths"]), "paths of {header}");
            assert_eq!(got.tags, strings(&c["tags"]), "tags of {header}");
        }
    }

    #[test]
    fn purge_by_tag_deletes_only_tagged_entries() {
        let cache = IsrCache::with_max(16);
        cache.insert("/blog/a", entry("/blog/a", &["posts", "post:a"]), 0);
        cache.insert("/blog/b", entry("/blog/b", &["posts", "post:b"]), 0);
        cache.insert("/about", entry("/about", &[]), 0);
        assert_eq!(cache.purge(purge_of(&[], &["post:a"])), 1);
        assert_eq!(keys(&cache), ["/about", "/blog/b"]);
        assert_eq!(cache.purge(purge_of(&[], &["posts"])), 1);
        assert_eq!(keys(&cache), ["/about"]);
        assert_eq!(cache.purge(purge_of(&[], &[])), 0);
    }

    #[test]
    fn purge_by_path_covers_every_query_vary_and_route_variant() {
        let cache = IsrCache::with_max(16);
        for key in [
            "/blog",
            "/blog?page=2",
            "/blog\u{1e}http://a.test\u{1f}cookie=x",
            "/blog\u{1d}/posts",
        ] {
            cache.insert(key, entry("/blog", &[]), 0);
        }
        cache.insert("/blog/", entry("/blog/", &[]), 0);
        cache.insert("/blogroll", entry("/blogroll", &[]), 0);
        assert_eq!(cache.purge(purge_of(&["/blog"], &[])), 4);
        assert_eq!(keys(&cache), ["/blog/", "/blogroll"]);
    }

    #[test]
    fn a_render_started_before_a_purge_is_not_stored() {
        let cache = IsrCache::with_max(16);
        cache.insert("/p", entry("/p", &["t"]), cache.epoch());
        // A background revalidation (or a MISS render) starts, then the page is purged.
        let started = cache.epoch();
        assert_eq!(cache.purge(purge_of(&[], &["t"])), 1);
        cache.insert("/p", entry("/p", &["t"]), started);
        assert!(
            keys(&cache).is_empty(),
            "the stale render must not come back"
        );
        // A purge of something else doesn't block it; a render started after the purge is stored.
        let other = cache.epoch();
        cache.purge(purge_of(&["/elsewhere"], &[]));
        cache.insert("/p", entry("/p", &["t"]), other);
        assert_eq!(keys(&cache), ["/p"]);
        // A purge of a page that isn't cached yet still stops its first render.
        let first = cache.epoch();
        cache.purge(purge_of(&["/new"], &[]));
        cache.insert("/new", entry("/new", &[]), first);
        assert_eq!(keys(&cache), ["/p"]);
    }

    #[test]
    fn a_render_older_than_the_purge_log_is_not_stored() {
        let cache = IsrCache::with_max(16);
        let started = cache.epoch();
        for i in 0..=PURGE_LOG {
            cache.purge(purge_of(&[&format!("/x{i}")], &[]));
        }
        cache.insert("/p", entry("/p", &[]), started);
        assert!(keys(&cache).is_empty());
        cache.insert("/p", entry("/p", &[]), cache.epoch());
        assert_eq!(keys(&cache), ["/p"]);
    }

    #[test]
    fn purge_lines_need_the_publish_token() {
        let token = crate::live::publish_token();
        let ok = purge_line(&format!("NOWAKI_PURGE {token} t:posts,p:/blog")).unwrap();
        assert_eq!(
            ok,
            Purge {
                epoch: 0,
                paths: vec!["/blog".into()],
                tags: vec!["posts".into()]
            }
        );
        assert_eq!(purge_line("NOWAKI_PURGE wrong t:posts"), None);
        assert_eq!(purge_line("NOWAKI_PURGE t:posts"), None);
        assert_eq!(purge_line(&format!("[app] NOWAKI_PURGE {token} t:x")), None);
    }

    #[test]
    fn internal_response_headers_never_pass_through() {
        assert!(is_internal_response_header("x-nowaki-purge"));
        assert!(is_internal_response_header("x-nowaki-tags"));
        assert!(is_internal_response_header("x-nowaki-route"));
        // The client router reads this one from an intercepted fragment.
        assert!(!is_internal_response_header("x-nowaki-slot"));
        assert!(!is_internal_response_header("cache-control"));
    }
}
