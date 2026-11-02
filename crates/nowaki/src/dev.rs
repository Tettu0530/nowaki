use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
    core: NowakiCore,
    hmr_tx: broadcast::Sender<String>,
    ssr_version: AtomicU64,
    sidecar_port: u16,
    http: reqwest::Client,
    live_hub: Arc<crate::live::LiveHub>,
    /// /@fs/ で配信を許可するルート集合（実体パス）。これ以外への到達を弾く。
    fs_allow: Vec<PathBuf>,
    /// --host で全インターフェース公開しているか。WS の Origin/Host 検証に使う。
    expose: bool,
}

pub async fn run(root: PathBuf, port: u16, expose: bool, open: bool) -> Result<()> {
    let started = Instant::now();

    crate::typegen::write(&root).ok();

    let sidecar = sidecar::spawn(&root, port).await?;

    let plugin_host = crate::plugins::start(&root)?;
    let mut core = NowakiCore::new(root.clone());
    if let Some(ph) = &plugin_host {
        core.set_plugins(ph.bridge.clone());
    }

    let (hmr_tx, _) = broadcast::channel(64);
    let state = Arc::new(DevState {
        core,
        hmr_tx: hmr_tx.clone(),
        ssr_version: AtomicU64::new(1),
        sidecar_port: sidecar.port,
        // リダイレクト(302等)はブラウザへ素通しする（サーバー側で追従しない）。
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client の構築に失敗"),
        live_hub: crate::live::LiveHub::new(),
        fs_allow: compute_fs_allow(&root),
        expose,
    });

    let _watcher = start_watcher(&root, state.clone())?;

    let app = Router::new()
        .route("/__nowaki/hmr", get(hmr_ws))
        .route("/__nowaki/live", get(live_ws))
        .route("/__nowaki/server-functions", get(server_functions))
        .route("/__nowaki/ssr-module", get(ssr_module))
        .route("/@fs/{*path}", get(serve_fs))
        .fallback(serve_or_proxy)
        .with_state(state);

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
    );

    if open {
        crate::ui::open_browser(&format!("http://localhost:{port}/"));
    }

    axum::serve(listener, app).await?;
    drop(plugin_host);
    drop(sidecar);
    Ok(())
}

/// ファイル監視 → ssr_version更新 + reloadブロードキャスト (100msデバウンス)
fn start_watcher(root: &Path, state: Arc<DevState>) -> Result<notify::RecommendedWatcher> {
    let root_owned = root.to_path_buf();
    let last_fire = Mutex::new(Instant::now() - Duration::from_secs(1));
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let relevant: Vec<_> = event
            .paths
            .iter()
            .filter(|p| {
                let s = p.to_string_lossy();
                !s.contains("/node_modules/")
                    && !s.contains("/.git/")
                    && !s.contains("/dist/")
                    && !s.contains("/target/")
                    && !s.contains("/.nowaki/")
            })
            .collect();
        if relevant.is_empty() {
            return;
        }
        {
            let mut last = last_fire.lock().unwrap();
            if last.elapsed() < Duration::from_millis(100) {
                return;
            }
            *last = Instant::now();
        }
        if relevant
            .iter()
            .any(|p| p.to_string_lossy().contains("/routes/"))
        {
            crate::typegen::write(&state.core.root).ok();
        }
        state.ssr_version.fetch_add(1, Ordering::SeqCst);
        let island_only = relevant
            .iter()
            .all(|p| p.to_string_lossy().contains("/islands/"));
        let kind = if island_only { "update" } else { "reload" };
        let files: Vec<String> = relevant
            .iter()
            .map(|p| {
                p.strip_prefix(&state.core.root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        crate::ui::hmr_log(kind, &files);
        let _ = state.hmr_tx.send(json!({ "type": kind }).to_string());
    })?;
    watcher.watch(&root_owned, RecursiveMode::Recursive)?;
    Ok(watcher)
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

/// サーバーリアクティブ島の WS。セッションロジックは crate::live が担う。
async fn live_ws(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    State(state): State<Arc<DevState>>,
) -> Response {
    // クロスサイト WebSocket ハイジャック(CSWSH)対策: 異オリジンからの upgrade を拒否。
    if !ws_origin_ok(&headers, state.expose) {
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    let http = state.http.clone();
    let port = state.sidecar_port;
    let version = state.ssr_version.load(Ordering::SeqCst).to_string();
    let hub = state.live_hub.clone();
    ws.on_upgrade(move |socket| crate::live::handle(socket, hub, http, port, version))
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

/// サーバー関数の allowlist（id → { module, export }）。dev は build しないので
/// サイドカーはこれを引いて RPC を dispatch する。
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
    #[allow(dead_code)] // キャッシュバスター (Nodeローダーが付与)
    v: Option<String>,
}

/// Nodeローダーフック向けの SSR 変換。`path` はユーザー入力なので実体パスへ正規化し、
/// 許可ルート配下・非機微の変換対象だけを通す（`?path=/etc/passwd` 等の任意ファイル読み取り防止）。
async fn ssr_module(
    State(state): State<Arc<DevState>>,
    Query(q): Query<SsrModuleQuery>,
) -> Response {
    let Ok(canon) = tokio::fs::canonicalize(&q.path).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !fs_path_allowed(&canon, &state.fs_allow) || !is_transformable(&canon) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    transform_response(state, canon, Mode::Ssr).await
}

/// /@fs/<絶対パス>: アプリルート外 (pnpmストア等) のファイル配信。`rest` はユーザー入力なので
/// 実体パスへ正規化してから許可ルート配下・非機微を検証する（パストラバーサル防止）。
async fn serve_fs(
    State(state): State<Arc<DevState>>,
    axum::extract::Path(rest): axum::extract::Path<String>,
) -> Response {
    let requested = PathBuf::from(format!("/{rest}"));
    let Ok(canon) = tokio::fs::canonicalize(&requested).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !fs_path_allowed(&canon, &state.fs_allow) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    serve_file(state, canon).await
}

/// フォールバック: アプリルート配下のファイルならば配信、さもなくばサイドカーへSSRプロキシ
async fn serve_or_proxy(State(state): State<Arc<DevState>>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    // 仮想 id に `..` は無いので弾く（合成ディレクトリ実在時の root.join 経由トラバーサル防止）。
    if path.starts_with(&format!("/{VIRTUAL_DIR}/")) {
        if path.split('/').any(|seg| seg == "..") {
            return (StatusCode::NOT_FOUND, "not found").into_response();
        }
        let abs = state.core.root.join(path.trim_start_matches('/'));
        return transform_response(state, abs, Mode::Browser).await;
    }
    if req.method() == axum::http::Method::GET && path != "/" {
        let candidate = state.core.root.join(path.trim_start_matches('/'));
        if candidate.is_file() {
            // `..`/symlink でルート外へ抜けていないか実体で確認し、機微パスも配信しない
            // （root は main.rs で canonicalize 済み）。
            match candidate.canonicalize() {
                Ok(canon) if canon.starts_with(&state.core.root) && !is_denied_fs_path(&canon) => {
                    return serve_file(state, candidate).await;
                }
                _ => {}
            }
        }
    }
    proxy_to_sidecar(state, req).await
}

async fn serve_file(state: Arc<DevState>, abs: PathBuf) -> Response {
    // .css は <style> を注入する JS シムとして配信する（import で副作用適用）。
    // *.module.css はクラス名をスコープ化し、名前マップを default export する。
    if nowaki_core::css::is_css(&abs) {
        return match tokio::fs::read_to_string(&abs).await {
            Ok(css) => {
                let id = abs.to_string_lossy();
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
    // oxc変換はCPUバウンドなのでblockingプールで実行
    let core_state = state.clone();
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
            eprintln!("[nowaki] 変換エラー: {msg}");
            // 診断はソース全文を含み得るので HTTP ボディに載せず、同一オリジンの HMR オーバーレイへだけ送る。
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
    // 元 Host は剥がすが、同一オリジン検証（サーバー関数の CSRF 対策）用に転送する。
    if let Some(host) = headers.get(header::HOST) {
        builder = builder.header("x-forwarded-host", host);
    }
    for (name, value) in headers.iter() {
        if name != header::HOST {
            builder = builder.header(name, value);
        }
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
            let bytes = resp.bytes().await.unwrap_or_default();
            response.body(Body::from(bytes)).unwrap_or_else(|e| {
                (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
            })
        }
        Err(err) => {
            crate::ui::request_log(&method_str, &log_path, 502, started.elapsed().as_millis());
            (
                StatusCode::BAD_GATEWAY,
                format!("SSRサイドカーへの接続に失敗: {err}"),
            )
                .into_response()
        }
    }
}

/// /@fs/ の許可ルート: アプリルートとワークスペースルート（pnpm/モノレポの共有 node_modules）。
/// それ以外（`/etc`・ホーム・ルート外の `.env` 等）への到達を弾く。
fn compute_fs_allow(root: &Path) -> Vec<PathBuf> {
    let mut allow = Vec::new();
    if let Ok(c) = root.canonicalize() {
        allow.push(c);
    }
    if let Some(ws) = workspace_root(root) {
        if let Ok(c) = ws.canonicalize() {
            if !allow.contains(&c) {
                allow.push(c);
            }
        }
    }
    allow
}

/// 最も近いワークスペース境界（`pnpm-workspace.yaml` か `.git`）。
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

/// 許可ルート配下でも配信を拒否する機微パス（`.git` 配下・`.env*`・秘密鍵）。
fn is_denied_fs_path(p: &Path) -> bool {
    p.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == ".git" || s == ".env" || s.starts_with(".env.")
    }) || matches!(p.extension().and_then(|e| e.to_str()), Some("pem" | "key"))
}

fn fs_path_allowed(canon: &Path, allow: &[PathBuf]) -> bool {
    !is_denied_fs_path(canon) && allow.iter().any(|root| canon.starts_with(root))
}

fn is_loopback_host(host: &str) -> bool {
    let h = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else if host.matches(':').count() >= 2 {
        // ブラケット無しの IPv6（例 `::1`）はポートを持たない。
        host
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    matches!(h, "localhost" | "127.0.0.1" | "::1")
}

/// WebSocket upgrade の Origin を検証する（CSWSH 対策）。Origin 無し（非ブラウザ）は許可、
/// 同一オリジンは許可だが既定バインドでは DNS リバインディング対策に Host をループバックへ限定。
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
    // Host と不一致でも、明示的なループバック Origin（localhost:port 等）は許可。
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
        // 許可ルート外（任意ファイル読み取り）は弾く
        assert!(!fs_path_allowed(Path::new("/etc/passwd"), &allow));
        assert!(!fs_path_allowed(Path::new("/home/u/.ssh/id_rsa"), &allow));
        // 前方一致の取りこぼし（兄弟ディレクトリ）も弾く
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
        // 許可ルート配下でも .env / .git 配下 / 秘密鍵は配信しない
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
        // ".env" を名前に含むだけのディレクトリは誤爆させない
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
        // 既定バインド: localhost への異オリジン接続を弾く（CSWSH）
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
        // Origin==Host だが Host が非ループバック → 既定バインドでは拒否、--host では許可
        let h = hdrs(&[
            ("host", "attacker.test:3000"),
            ("origin", "http://attacker.test:3000"),
        ]);
        assert!(!ws_origin_ok(&h, false));
        assert!(ws_origin_ok(&h, true));
    }

    #[test]
    fn ws_origin_allows_missing_origin() {
        // ネイティブ WS クライアント（Origin 無し）は許可
        let h = hdrs(&[("host", "localhost:3000")]);
        assert!(ws_origin_ok(&h, false));
    }

    #[test]
    fn ws_origin_lan_same_origin_under_host() {
        // --host で LAN IP の同一オリジンは許可
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
}
