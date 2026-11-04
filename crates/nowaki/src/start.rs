//! Rust hot path for production serving. Used by `nowaki start`.
//!
//! Rust (axum) handles the HTTP edge, static files, and HTML assembly; the Node prod-sidecar
//! only renders components (pages return body + meta as JSON). Separate from the deploy adapters.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
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
}

#[derive(serde::Deserialize)]
struct PageMeta {
    body: String,
    title: String,
    head: String,
    lang: String,
}

struct ProdState {
    client_dir: PathBuf,
    sidecar_port: u16,
    http: reqwest::Client,
    manifest: Manifest,
    live_hub: Arc<crate::live::LiveHub>,
    isr: IsrCache,
}

/// In-memory ISR cache (routes with `export const revalidate = <seconds>`, stale-while-revalidate).
struct IsrCache {
    entries: Mutex<HashMap<String, Arc<CacheEntry>>>,
    inflight: Mutex<HashSet<String>>, // revalidation single-flight
    specs: Mutex<HashMap<String, VarySpec>>, // learned Vary spec per pathname
    max: usize,                       // entry cap (oldest evicted when exceeded)
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
    html: String,
    headers: Vec<(String, String)>, // response headers to restore (cookie/length headers excluded)
    stored_at: Instant,
    revalidate: Duration,
    // Request context for regenerating the same variant during background revalidation.
    refetch_path: String,                   // path(+query) sent to the sidecar
    refetch_headers: Vec<(String, String)>, // actual values of the folded-in Vary headers
}

impl IsrCache {
    fn new() -> Self {
        let max = std::env::var("NOWAKI_ISR_MAX")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(1024);
        IsrCache {
            entries: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashSet::new()),
            specs: Mutex::new(HashMap::new()),
            max,
        }
    }
}

pub async fn run(root: PathBuf, port: u16, expose: bool) -> Result<()> {
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

    let mut child = Command::new("node")
        .arg("--enable-source-maps")
        .arg(&entry)
        .current_dir(&root)
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
        println!("[sidecar] {line}");
    }
    let sidecar_port =
        sidecar_port.ok_or_else(|| anyhow!("prod-sidecar exited without reporting READY"))?;
    tokio::spawn(async move {
        while let Ok(Some(l)) = lines.next_line().await {
            println!("[sidecar] {l}");
        }
    });

    let manifest_text = std::fs::read_to_string(client_dir.join("manifest.json"))?;
    let manifest: Manifest = serde_json::from_str(&manifest_text).unwrap_or_default();

    let host = if expose {
        "0.0.0.0".to_string()
    } else {
        std::env::var("NOWAKI_HOST").unwrap_or_else(|_| "127.0.0.1".to_string())
    };
    let state = Arc::new(ProdState {
        client_dir,
        sidecar_port,
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        manifest,
        live_hub: crate::live::LiveHub::new(),
        isr: IsrCache::new(),
    });

    let app = Router::new()
        .route("/__nowaki/live", get(live_ws))
        .fallback(any(handle))
        .with_state(state)
        .layer(axum::middleware::from_fn(crate::csp::layer))
        .layer(axum::middleware::map_response(crate::security_headers::add));
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    let actual = listener.local_addr()?.port();
    // Also report the actual port when PORT=0 (a marker grepped by prerender / adapters / bench; keep it).
    println!("NOWAKI_START_READY {actual}");
    crate::ui::server_banner(
        "Nowaki (production)",
        env!("CARGO_PKG_VERSION"),
        actual,
        started.elapsed().as_millis(),
        &["Rust front", "Node renderer"],
        expose || host == "0.0.0.0",
    );
    // The sidecar lives outside the shared state (request tasks hold that), so it is killed here on shutdown.
    tokio::select! {
        r = std::future::IntoFuture::into_future(axum::serve(listener, app)) => r?,
        _ = crate::shutdown::signal() => {}
    }
    let _ = child.kill().await;
    Ok(())
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
    ws.on_upgrade(move |socket| crate::live::handle(socket, hub, http, port, "prod".to_string()))
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

async fn handle(State(state): State<Arc<ProdState>>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    if crate::forward::is_internal_path(&path) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    // Rust serves static assets directly (high-volume hot path).
    if req.method() == Method::GET && path.starts_with("/_nowaki/") {
        return serve_static(&state, &path).await;
    }
    if req.method() == Method::GET {
        let pathname = req.uri().path().to_string();
        let query = req.uri().query().map(|q| q.to_string());
        let spec = state
            .isr
            .specs
            .lock()
            .unwrap()
            .get(&pathname)
            .cloned()
            .unwrap_or_default();
        if !spec.no_cache {
            let key = isr_key(&pathname, query.as_deref(), req.headers(), &spec);
            if let Some(resp) = isr_lookup(&state, &key) {
                return resp;
            }
        }
        return proxy(state, req, true).await;
    }
    proxy(state, req, false).await
}

/// Header values are folded in the BTreeSet's stable order.
fn isr_key(
    pathname: &str,
    query: Option<&str>,
    headers: &axum::http::HeaderMap,
    spec: &VarySpec,
) -> String {
    let mut k = String::from(pathname);
    if spec.query {
        if let Some(q) = query {
            k.push('?');
            k.push_str(q);
        }
    }
    for name in &spec.headers {
        let val = headers
            .get(name.as_str())
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        k.push('\u{1f}'); // Unit Separator: header boundary (a control char that never appears in values)
        k.push_str(name);
        k.push('=');
        k.push_str(val);
    }
    k
}

fn isr_lookup(state: &Arc<ProdState>, key: &str) -> Option<Response> {
    let entry = state.isr.entries.lock().unwrap().get(key).cloned()?;
    let stale = entry.stored_at.elapsed() >= entry.revalidate;
    if stale {
        spawn_revalidate(state.clone(), key.to_string());
    }
    Some(cached_response(&entry, if stale { "STALE" } else { "HIT" }))
}

fn cached_response(entry: &CacheEntry, cache_status: &str) -> Response {
    let mut builder = Response::builder()
        .status(entry.status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("x-nowaki-cache", cache_status);
    for (n, v) in &entry.headers {
        builder = builder.header(n.as_str(), v.as_str());
    }
    builder
        .body(Body::from(entry.html.clone()))
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
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
    let (refetch_path, refetch_headers) = {
        let e = state.isr.entries.lock().unwrap().get(key).cloned()?;
        (e.refetch_path.clone(), e.refetch_headers.clone())
    };
    let url = format!("http://127.0.0.1:{}{}", state.sidecar_port, refetch_path);
    let mut req = state.http.get(&url);
    for (n, v) in &refetch_headers {
        req = req.header(n, v);
    }
    let resp = req.send().await.ok()?;
    let entry = page_to_entry(state, resp, refetch_path, refetch_headers).await?;
    isr_store(state, key, entry);
    Some(())
}

/// Conditions: 200 / x-nowaki-page / x-nowaki-revalidate>0 / no Set-Cookie (per-user excluded).
async fn page_to_entry(
    state: &ProdState,
    resp: reqwest::Response,
    refetch_path: String,
    refetch_headers: Vec<(String, String)>,
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
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.ok()?;
    let meta: PageMeta = serde_json::from_slice(&bytes).ok()?;
    let html = assemble(&state.manifest, &meta);
    Some(CacheEntry {
        status,
        html,
        headers: kept,
        stored_at: Instant::now(),
        revalidate: Duration::from_secs(secs),
        refetch_path,
        refetch_headers,
    })
}

fn isr_secs_of(h: &reqwest::header::HeaderMap) -> Option<u64> {
    h.get("x-nowaki-revalidate")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
}

/// Set-Cookie is never restored from the shared cache.
fn kept_headers(h: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (name, value) in h.iter() {
        let n = name.as_str();
        if n.starts_with("x-nowaki-")
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
    query: Option<&str>,
    req_headers: &axum::http::HeaderMap,
    resp_headers: &reqwest::header::HeaderMap,
    secs: u64,
    status: u16,
    html: &str,
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

    let spec = {
        let mut specs = state.isr.specs.lock().unwrap();
        let spec = specs.entry(pathname.to_string()).or_default();
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

    let key = isr_key(pathname, query, req_headers, &spec);
    let refetch_path = if spec.query {
        match query {
            Some(q) => format!("{pathname}?{q}"),
            None => pathname.to_string(),
        }
    } else {
        pathname.to_string()
    };
    let refetch_headers: Vec<(String, String)> = spec
        .headers
        .iter()
        .filter_map(|n| {
            req_headers
                .get(n.as_str())
                .and_then(|v| v.to_str().ok())
                .map(|v| (n.clone(), v.to_string()))
        })
        .collect();

    isr_store(
        state,
        &key,
        CacheEntry {
            status,
            html: html.to_string(),
            headers: kept_headers(resp_headers),
            stored_at: Instant::now(),
            revalidate: Duration::from_secs(secs),
            refetch_path,
            refetch_headers,
        },
    );
}

/// When over the cap, evict the oldest entry of the same pathname first (a query/header flood doesn't hit other routes).
fn isr_store(state: &ProdState, key: &str, entry: CacheEntry) {
    let mut map = state.isr.entries.lock().unwrap();
    if map.len() >= state.isr.max && !map.contains_key(key) {
        let path = key.split(['?', '\u{1f}']).next().unwrap_or(key);
        let victim = map
            .iter()
            .filter(|(k, _)| k.split(['?', '\u{1f}']).next() == Some(path))
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

async fn serve_static(state: &ProdState, path: &str) -> Response {
    let Some(name) = asset_name(path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
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

async fn proxy(state: Arc<ProdState>, req: Request, cacheable: bool) -> Response {
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
    let body = match axum::body::to_bytes(req.into_body(), 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };

    let mut builder = state.http.request(method, &url).body(body.to_vec());
    builder = crate::forward::apply(builder, &headers, crate::forward::trust_proxy());

    let resp = match builder.send().await {
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
    let bytes = resp.bytes().await.unwrap_or_default();

    if is_page {
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
                    query.as_deref(),
                    &headers,
                    &resp_headers,
                    secs,
                    status.as_u16(),
                    &html,
                );
            }
        }
        builder
            .body(Body::from(html))
            .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
    } else {
        // Pass through (API / redirect / stream / streaming SSR / built-in 404/500).
        let mut builder = Response::builder().status(status.as_u16());
        for (name, value) in resp_headers.iter() {
            if name != header::TRANSFER_ENCODING && name != header::CONTENT_LENGTH {
                builder = builder.header(name, value);
            }
        }
        builder
            .body(Body::from(bytes))
            .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
    }
}

/// Rust port of prodDocument (JS). Islands are picked from <nowaki-island name="..."> in the body.
fn assemble(manifest: &Manifest, meta: &PageMeta) -> String {
    let island_names = scan_island_names(&meta.body);
    let has_islands = !island_names.is_empty() && manifest.runtime.is_some();

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
        .map(|f| format!("<link rel=\"modulepreload\" href=\"/_nowaki/{f}\" />"))
        .collect::<Vec<_>>()
        .join("\n");
    let runtime_script = if has_islands {
        // Put the lazy router chunk's URL in data-router (islands.js imports it when idle).
        let data_router = match &manifest.router_runtime {
            Some(r) => format!(" data-router=\"/_nowaki/{r}\""),
            None => String::new(),
        };
        format!(
            "<script id=\"nowaki-runtime\" type=\"module\" src=\"/_nowaki/{}\"{data_router}></script>",
            manifest.runtime.as_ref().unwrap()
        )
    } else {
        String::new()
    };
    let live_script = if meta.body.contains("<nowaki-live") {
        match &manifest.live_runtime {
            Some(f) => format!("<script type=\"module\" src=\"/_nowaki/{f}\"></script>"),
            None => String::new(),
        }
    } else {
        String::new()
    };

    format!(
        "<!DOCTYPE html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n<title>{title}</title>\n<meta name=\"nowaki-head\" content=\"start\" />\n{preload}\n{head}\n<meta name=\"nowaki-head\" content=\"end\" />\n</head>\n<body>\n{body}\n{runtime_script}\n{live_script}\n</body>\n</html>",
        lang = escape_html(&meta.lang),
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
}
