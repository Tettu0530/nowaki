//! MCP endpoint for `nowaki dev` (`/__nowaki/mcp`): read-only tools that let a coding agent inspect
//! the running app (routes, module graph, recent errors, dev config, one page, Jetstream).
//!
//! The dev toolbar (`client/toolbar.js`) reads the same data from `GET /__nowaki/devtools?url=…`
//! ([`devtools`]): the `page`, `live` and `recent_errors` functions serve both.
//!
//! Transport is MCP Streamable HTTP with plain JSON responses: no SSE stream (GET is 405) and no
//! sessions, which the spec allows for a server that only answers requests. JSON-RPC is handled
//! here directly; a handful of tools don't need an SDK.
//!
//! Trust boundary: the tools expose source paths and error text (which can quote source), so every
//! request must come from a loopback peer with a loopback `Host` and, if present, a loopback
//! `Origin`. That holds with `--host` too and defeats DNS rebinding. Only `nowaki dev` mounts it
//! (and the devtools path, behind the same gate); `forward::is_internal_path` keeps `nowaki start`
//! from forwarding either path.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::dev::DevState;

/// The MCP endpoint.
pub const PATH: &str = "/__nowaki/mcp";
/// The dev toolbar's data (`GET ?url=<browser path>`), behind the same gate as [`PATH`].
pub const DEVTOOLS_PATH: &str = "/__nowaki/devtools";

/// Newest first; `initialize` falls back to the first when the client asks for another.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];

const MAX_ERRORS: usize = 50;
/// Per-field cap so a huge diagnostic can't grow the log much past 50 entries' worth.
const MAX_FIELD: usize = 16 * 1024;

/// The endpoint's loopback URL, for the startup banner and the `dev_config` tool.
pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{PATH}")
}

/// One recorded dev error. `source` is `build`, `ssr`, `live` or `hmr`; `file` is relative to the
/// app root (with `:line:column` when it comes from a stack), `path` the request's browser path.
#[derive(Clone, Debug, serde::Serialize)]
pub struct DevError {
    pub time: String,
    pub source: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

/// The last `MAX_ERRORS` dev errors (build/transform, SSR, live, HMR watcher).
pub struct ErrorLog {
    root: PathBuf,
    entries: Mutex<VecDeque<DevError>>,
}

#[derive(serde::Deserialize)]
struct SidecarError {
    source: String,
    message: String,
    stack: Option<String>,
    path: Option<String>,
}

impl ErrorLog {
    /// An empty log for the app at `root` (paths are shown relative to it).
    pub fn new(root: &Path) -> Arc<Self> {
        Arc::new(Self {
            root: root.to_path_buf(),
            entries: Mutex::new(VecDeque::with_capacity(MAX_ERRORS)),
        })
    }

    /// Adds an error, dropping the oldest past `MAX_ERRORS`. Without `file`, the first app frame
    /// of `stack` names it. Message and stack are truncated to `MAX_FIELD` bytes.
    pub fn record(
        &self,
        source: &str,
        message: &str,
        file: Option<&Path>,
        path: Option<String>,
        stack: Option<String>,
    ) {
        let file = file
            .map(|f| self.display_path(f))
            .or_else(|| stack.as_deref().and_then(|s| stack_file(&self.root, s)));
        let entry = DevError {
            time: rfc3339(SystemTime::now()),
            source: source.to_string(),
            message: truncate(message),
            file,
            path,
            stack: stack.as_deref().map(truncate),
        };
        let mut q = self.entries.lock().unwrap();
        if q.len() == MAX_ERRORS {
            q.pop_front();
        }
        q.push_back(entry);
    }

    /// `NOWAKI_DEV_ERROR <token> <json>` from the sidecar (consumed, returns true).
    pub fn handle_sidecar_line(&self, line: &str) -> bool {
        let Some(rest) = line.strip_prefix("NOWAKI_DEV_ERROR ") else {
            return false;
        };
        let Some((token, body)) = rest.split_once(' ') else {
            return false;
        };
        if token != crate::live::publish_token() {
            return false;
        }
        if let Ok(e) = serde_json::from_str::<SidecarError>(body) {
            let source = if e.source == "live" { "live" } else { "ssr" };
            self.record(source, &e.message, None, e.path, e.stack);
        }
        true
    }

    fn recent(&self, limit: usize, source: Option<&str>) -> (Vec<DevError>, usize) {
        let q = self.entries.lock().unwrap();
        let list = q
            .iter()
            .rev()
            .filter(|e| source.is_none_or(|s| e.source == s))
            .take(limit)
            .cloned()
            .collect();
        (list, q.len())
    }

    fn display_path(&self, p: &Path) -> String {
        rel_path(&self.root, p)
    }
}

fn truncate(s: &str) -> String {
    if s.len() <= MAX_FIELD {
        return s.to_string();
    }
    let mut end = MAX_FIELD;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… (truncated)", &s[..end])
}

fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// First stack frame in an app file (not node_modules), as `routes/x.tsx:12:5`. Frames are
/// `at fn (loc)` or `at loc`; `loc` is a `file://` URL or, after source maps, a plain path.
fn stack_file(root: &Path, stack: &str) -> Option<String> {
    for line in stack.lines() {
        let line = line.trim();
        let Some(at) = line.strip_prefix("at ") else {
            continue;
        };
        let loc = match (at.rfind('('), at.strip_suffix(')')) {
            (Some(open), Some(inner)) => &inner[open + 1..],
            _ => at,
        };
        let (frame, is_url) = match loc.strip_prefix("file://") {
            Some(rest) => (rest, true),
            None => (loc, false),
        };
        // `/abs/routes/x.tsx?v=3:12:5` → path + `:12:5`
        let (path, pos) = match frame.find('?') {
            Some(q) => {
                let after = &frame[q..];
                (&frame[..q], after.find(':').map_or("", |c| &after[c..]))
            }
            None => {
                let mut parts = frame.rsplitn(3, ':');
                let (col, line, path) = (parts.next(), parts.next(), parts.next());
                match (col, line, path) {
                    (Some(_), Some(_), Some(p)) => (p, &frame[p.len()..]),
                    _ => (frame, ""),
                }
            }
        };
        let mut path = if is_url {
            percent_decode(path)
        } else {
            path.to_string()
        };
        // file:///C:/x → C:/x
        if is_url && path.as_bytes().get(2) == Some(&b':') && path.starts_with('/') {
            path.remove(0);
        }
        let p = PathBuf::from(&path);
        if p.starts_with(root) && !path.contains("/node_modules/") {
            return Some(format!("{}{pos}", rel_path(root, &p)));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn rfc3339(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let (y, m, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// Loopback peer, loopback `Host`, and no `Origin` or a loopback one.
pub(crate) fn request_allowed(peer: IpAddr, headers: &HeaderMap) -> bool {
    if !peer.to_canonical().is_loopback() {
        return false;
    }
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if !crate::dev::is_loopback_host(host) {
        return false;
    }
    match headers.get(header::ORIGIN) {
        None => true,
        Some(v) => v
            .to_str()
            .ok()
            .and_then(|o| {
                o.strip_prefix("http://")
                    .or_else(|| o.strip_prefix("https://"))
            })
            .is_some_and(|h| crate::dev::is_loopback_host(h.trim_end_matches('/'))),
    }
}

/// `/__nowaki/mcp`: one JSON-RPC message or batch per POST, behind [`request_allowed`].
pub async fn handle(
    State(state): State<Arc<DevState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !request_allowed(peer.ip(), &headers) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    if method != Method::POST {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "POST")],
            "this MCP server answers POST only (no SSE stream)",
        )
            .into_response();
    }
    if let Some(v) = headers.get("mcp-protocol-version") {
        if !v.to_str().is_ok_and(|v| PROTOCOL_VERSIONS.contains(&v)) {
            return json_response(
                StatusCode::BAD_REQUEST,
                error(Value::Null, -32600, "unsupported MCP-Protocol-Version"),
            );
        }
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            error(Value::Null, -32700, "parse error"),
        );
    };
    let reply = match msg {
        Value::Array(batch) if !batch.is_empty() => {
            let mut out = Vec::new();
            for m in &batch {
                if let Some(r) = run(&state, route(m)).await {
                    out.push(r);
                }
            }
            (!out.is_empty()).then_some(Value::Array(out))
        }
        m => run(&state, route(&m)).await,
    };
    match reply {
        Some(v) => json_response(StatusCode::OK, v),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

fn json_response(status: StatusCode, v: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        v.to_string(),
    )
        .into_response()
}

#[derive(Debug, PartialEq)]
enum Step {
    Reply(Value),
    /// Notification or client response: HTTP 202, no body.
    Accepted,
    Call {
        id: Value,
        name: String,
        args: Value,
    },
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn route(msg: &Value) -> Step {
    let Some(obj) = msg.as_object() else {
        return Step::Reply(error(Value::Null, -32600, "invalid request"));
    };
    let id = obj.get("id").cloned();
    let valid_id = matches!(id, Some(Value::String(_) | Value::Number(_)));
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        let id = if valid_id { id.unwrap() } else { Value::Null };
        return Step::Reply(error(id, -32600, "invalid request"));
    }
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        if obj.contains_key("result") || obj.contains_key("error") {
            return Step::Accepted;
        }
        let id = if valid_id { id.unwrap() } else { Value::Null };
        return Step::Reply(error(id, -32600, "invalid request"));
    };
    let Some(id) = id else {
        return Step::Accepted;
    };
    if !valid_id {
        return Step::Reply(error(Value::Null, -32600, "invalid request id"));
    }
    let params = obj.get("params").cloned().unwrap_or(json!({}));
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            let version = asked
                .filter(|v| PROTOCOL_VERSIONS.contains(v))
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            Step::Reply(ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "nowaki-dev",
                        "title": "Nowaki dev server",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "instructions": "Read-only view of a running `nowaki dev` app. Paths are relative to the app root. Use `routes` for the route table, `module_graph` for imports/importers of a file and the island list, `recent_errors` after a failing request or edit.",
                }),
            ))
        }
        "ping" => Step::Reply(ok(id, json!({}))),
        "tools/list" => Step::Reply(ok(id, json!({ "tools": tool_list() }))),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Step::Reply(error(id, -32602, "missing tool name"));
            };
            if !TOOLS.contains(&name) {
                return Step::Reply(error(id, -32602, &format!("unknown tool: {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            if !args.is_object() {
                return Step::Reply(error(id, -32602, "arguments must be an object"));
            }
            Step::Call {
                id,
                name: name.to_string(),
                args,
            }
        }
        _ => Step::Reply(error(id, -32601, &format!("method not found: {method}"))),
    }
}

const TOOLS: [&str; 6] = [
    "routes",
    "module_graph",
    "recent_errors",
    "dev_config",
    "page",
    "live",
];

fn tool_list() -> Value {
    let ro = json!({ "readOnlyHint": true, "openWorldHint": false });
    json!([
        {
            "name": "routes",
            "title": "Routes",
            "description": "Every route the dev server knows, in match order: URL pattern, file, kind (page/api), the module's exports (revalidate = ISR seconds, csrf), plus layouts, middleware, boundaries, and the global CSP mode.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": ro,
        },
        {
            "name": "module_graph",
            "title": "Module graph",
            "description": "Islands (and which are live Jetstream islands). With `file`, also what that file imports and which app files import it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "App file, relative to the app root (e.g. routes/index.tsx) or absolute" }
                },
            },
            "annotations": ro,
        },
        {
            "name": "recent_errors",
            "title": "Recent errors",
            "description": "The most recent dev errors, newest first: build (transform errors, the ones the HMR overlay shows), ssr (render/API/middleware), live (Jetstream renders), hmr (file watcher). Keeps the last 50.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_ERRORS, "description": "Default 20" },
                    "source": { "type": "string", "enum": ["build", "ssr", "live", "hmr"] }
                },
            },
            "annotations": ro,
        },
        {
            "name": "dev_config",
            "title": "Dev config",
            "description": "Dev server settings (port, listen address, plugins), NOWAKI_* env flags, current Jetstream connections and rooms, and the recent revalidatePath / revalidateTag calls.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": ro,
        },
        {
            "name": "page",
            "title": "Page",
            "description": "What serves one URL: the matched route file and its params, layouts, middleware, ISR settings (revalidate, tags), the islands it can render (client or live, estimated gzip size, a hint when a client island could be live), its first-load JS (a dev estimate against `export const budget`, plus the last `nowaki build` figure when dist/ has one), and the recent revalidate calls. The dev toolbar shows the same data.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Browser path, e.g. /blog/hello (basePath and locale prefix included, as in the address bar)" }
                },
                "required": ["url"],
            },
            "annotations": ro,
        },
        {
            "name": "live",
            "title": "Jetstream",
            "description": "Open Jetstream (live island) WebSocket connections, the connection cap (NOWAKI_LIVE_MAX), and the rooms with their member counts.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": ro,
        },
    ])
}

async fn run(state: &Arc<DevState>, step: Step) -> Option<Value> {
    match step {
        Step::Reply(v) => Some(v),
        Step::Accepted => None,
        Step::Call { id, name, args } => {
            let result = match name.as_str() {
                "routes" => routes(state).await,
                "module_graph" => module_graph(state, &args).await,
                "recent_errors" => Ok(recent_errors(state, &args)),
                "page" => match args.get("url").and_then(Value::as_str) {
                    Some(url) => page(state, url).await,
                    None => Err("`url` is required (a browser path such as /blog/hello)".into()),
                },
                "live" => Ok(live(state)),
                _ => Ok(dev_config(state).await),
            };
            Some(ok(id, tool_result(result)))
        }
    }
}

fn tool_result(r: Result<Value, String>) -> Value {
    match r {
        Ok(v) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }],
            "structuredContent": v,
            "isError": false,
        }),
        Err(msg) => json!({
            "content": [{ "type": "text", "text": msg }],
            "isError": true,
        }),
    }
}

/// Route table and island registry from the sidecar, i.e. what rendering uses right now.
async fn dev_info(state: &DevState) -> Result<Value, String> {
    dev_info_query(state, "").await
}

/// `/__nowaki/dev-info` with extra query parameters (`&url=…` for one page, `&only=revalidations`).
async fn dev_info_query(state: &DevState, extra: &str) -> Result<Value, String> {
    let version = state.ssr_version.load(Ordering::SeqCst);
    let url = format!(
        "http://127.0.0.1:{}/__nowaki/dev-info?v={version}{extra}",
        state.sidecar_port
    );
    let resp = state
        .http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("SSR sidecar unreachable: {e}"))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("bad sidecar response: {e}"))?;
    let body: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("bad sidecar response: {e}"))?;
    if !status.is_success() {
        return Err(format!("sidecar error: {}", body["error"]));
    }
    Ok(body)
}

async fn routes(state: &DevState) -> Result<Value, String> {
    let info = dev_info(state).await?;
    let csp = match crate::csp::mode() {
        crate::csp::Mode::Off => "off",
        crate::csp::Mode::ReportOnly => "report-only",
        crate::csp::Mode::Enforce => "enforce",
    };
    Ok(json!({
        "routes": info["routes"],
        "conventions": info["conventions"],
        "csp": csp,
    }))
}

async fn module_graph(state: &Arc<DevState>, args: &Value) -> Result<Value, String> {
    let info = dev_info(state).await?;
    let islands = info["islands"].clone();
    let Some(file) = args.get("file").and_then(Value::as_str) else {
        return Ok(json!({ "islands": islands }));
    };
    let root = state.core.root.clone();
    let requested = Path::new(file);
    let abs = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let canon = dunce::canonicalize(&abs).map_err(|_| format!("file not found: {file}"))?;
    if !canon.starts_with(&root)
        || crate::dev::is_denied_fs_path(&canon)
        || !nowaki_core::is_transformable(&canon)
    {
        return Err(format!(
            "not an app module under the app root: {file} (expected a .ts/.tsx/.js/.jsx/.mjs/.tsrx file)"
        ));
    }
    let st = state.clone();
    let target = canon.clone();
    let graph = tokio::task::spawn_blocking(move || {
        let imports = nowaki_core::graph::module_imports(&st.core, &target);
        let importers = nowaki_core::graph::importers(&st.core, &target);
        (imports, importers)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (imports, importers) = graph;
    let imports = imports.map_err(|e| format!("{e:#}"))?;
    let rel = rel_path(&root, &canon);
    let island = islands
        .as_array()
        .and_then(|list| list.iter().find(|i| i["file"] == rel.as_str()))
        .cloned();
    Ok(json!({
        "file": rel,
        "island": island,
        "imports": imports.iter().map(|i| json!({
            "specifier": i.specifier,
            "resolved": i.resolved.as_deref().map(|p| rel_path(&root, p)),
            "dynamic": i.dynamic,
        })).collect::<Vec<_>>(),
        "importers": importers.iter().map(|p| rel_path(&root, p)).collect::<Vec<_>>(),
        "islands": islands,
    }))
}

fn recent_errors(state: &DevState, args: &Value) -> Value {
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map_or(20, |n| n.clamp(1, MAX_ERRORS as u64)) as usize;
    let source = args.get("source").and_then(Value::as_str);
    let (errors, total) = state.errors.recent(limit, source);
    json!({ "errors": errors, "stored": total, "capacity": MAX_ERRORS })
}

async fn dev_config(state: &DevState) -> Value {
    let flag = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let revalidations = dev_info_query(state, "&only=revalidations")
        .await
        .map(|v| v["revalidations"].clone())
        .unwrap_or(Value::Null);
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "root": state.core.root.display().to_string(),
        "port": state.port,
        "host": state.bind_ip.to_string(),
        "exposed": state.expose,
        "plugins": state.plugins,
        "mcp": url(state.port),
        "env": {
            "NOWAKI_CSP": flag("NOWAKI_CSP"),
            "NOWAKI_CSP_REPORT_URI": flag("NOWAKI_CSP_REPORT_URI"),
            "NOWAKI_TRUST_PROXY": flag("NOWAKI_TRUST_PROXY"),
            "NOWAKI_LIVE_MAX": flag("NOWAKI_LIVE_MAX"),
            "NOWAKI_LIVE_MAX_AGE": flag("NOWAKI_LIVE_MAX_AGE"),
            // Secret: only whether it is set.
            "NOWAKI_LIVE_SECRET": flag("NOWAKI_LIVE_SECRET").map(|_| "(set)"),
            "NOWAKI_TOOLBAR": flag("NOWAKI_TOOLBAR"),
            "NOWAKI_EDITOR": flag("NOWAKI_EDITOR"),
        },
        "live": live(state),
        "revalidations": revalidations,
    })
}

fn live(state: &DevState) -> Value {
    serde_json::to_value(state.live_hub.stats()).unwrap_or(Value::Null)
}

/// The `page` tool and the toolbar's page panel: the sidecar's view of the URL (route, layouts,
/// middleware, ISR exports), plus the islands the route can render and its first-load JS.
pub(crate) async fn page(state: &Arc<DevState>, url: &str) -> Result<Value, String> {
    if !url.starts_with('/') || url.len() > 2048 {
        return Err(
            "`url` must be a browser path starting with / (at most 2048 characters)".into(),
        );
    }
    let info = dev_info_query(state, &format!("&url={}", crate::dev::query_encode(url))).await?;
    let mut page = info["page"].clone();
    let root = state.core.root.clone();
    let route_file = page["route"]["file"].as_str().map(|f| root.join(f));
    let is_page = page["route"]["kind"] == "page";
    if let (Some(file), true) = (route_file, is_page) {
        let layouts: Vec<PathBuf> = page["layouts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|f| root.join(f))
            .collect();
        // `streaming = true` or `"early"`: the shell always loads the islands runtime.
        let streaming =
            page["route"]["streaming"] == true || page["route"]["streaming"].is_string();
        let st = state.clone();
        let js = tokio::task::spawn_blocking(move || {
            let runtime = runtime_dir(&st.core.root);
            page_js(&st.core, &file, &layouts, streaming, runtime.as_deref())
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Value::Object(m) = &mut page {
            m.insert("islands".into(), js.islands);
            m.insert("js".into(), js.js);
        }
    }
    if let Value::Object(m) = &mut page {
        m.insert("revalidations".into(), info["revalidations"].clone());
    }
    Ok(page)
}

/// The query of [`devtools`]: the browser path to describe (`/` when absent).
#[derive(serde::Deserialize)]
pub struct DevtoolsQuery {
    url: Option<String>,
}

/// `GET /__nowaki/devtools?url=…` for `client/toolbar.js`: [`page`], [`live`], the recent errors,
/// and how to link a file to the editor (`NOWAKI_EDITOR`). Same gate as the MCP endpoint, so a LAN
/// client under `--host` gets 403 (and the toolbar hides itself). Read-only.
pub async fn devtools(
    State(state): State<Arc<DevState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<DevtoolsQuery>,
) -> Response {
    if !request_allowed(peer.ip(), &headers) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let url = q.url.unwrap_or_else(|| "/".into());
    let page = page(&state, &url)
        .await
        .unwrap_or_else(|e| json!({ "error": e }));
    let editor = editor_template(&std::env::var("NOWAKI_EDITOR").unwrap_or_default());
    json_response(
        StatusCode::OK,
        json!({
            "page": page,
            "live": live(&state),
            "errors": recent_errors(&state, &json!({ "limit": 10 })),
            "editor": editor,
            "root": state.core.root.to_string_lossy().replace('\\', "/"),
            "hints": hints_enabled(),
        }),
    )
}

/// `NOWAKI_EDITOR` names → source link templates (`vscode` when unset). `{file}` is the absolute
/// path, `{line}` / `{column}` start at 1. The server only hands the template to the toolbar; it
/// never starts an editor itself.
const EDITORS: [(&str, &str); 7] = [
    ("vscode", "vscode://file/{file}:{line}:{column}"),
    ("code", "vscode://file/{file}:{line}:{column}"),
    (
        "vscode-insiders",
        "vscode-insiders://file/{file}:{line}:{column}",
    ),
    ("cursor", "cursor://file/{file}:{line}:{column}"),
    ("windsurf", "windsurf://file/{file}:{line}:{column}"),
    ("zed", "zed://file/{file}:{line}:{column}"),
    (
        "idea",
        "idea://open?file={file}&line={line}&column={column}",
    ),
];

/// A known editor's template, or a custom one (a URL template with `{file}` whose scheme isn't a
/// script or data URL). `off`, or anything else: None (the toolbar shows plain paths).
fn editor_template(v: &str) -> Option<String> {
    let v = v.trim();
    if v.is_empty() {
        return Some(EDITORS[0].1.to_string());
    }
    if let Some((_, t)) = EDITORS
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(v))
    {
        return Some((*t).to_string());
    }
    let scheme = v.split_once(':').map(|(s, _)| s.to_ascii_lowercase())?;
    let scheme_ok = scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && !matches!(scheme.as_str(), "javascript" | "data" | "vbscript" | "blob");
    (scheme_ok && v.contains("{file}")).then(|| v.to_string())
}

/// `NOWAKI_HINTS=0` hides the "could be live" hints in builds; the dev tools follow it.
fn hints_enabled() -> bool {
    !matches!(
        std::env::var("NOWAKI_HINTS").ok().as_deref(),
        Some("0" | "off" | "false")
    )
}

/// `node_modules/@nowaki-dev/runtime/client` of the app, when installed.
fn runtime_dir(root: &Path) -> Option<PathBuf> {
    dunce::canonicalize(root.join("node_modules/@nowaki-dev/runtime/client")).ok()
}

struct PageJs {
    islands: Value,
    js: Value,
}

/// The islands a page route can render and its first-load JS, counted like
/// `budget::route_first_load` does for a build: the islands runtime when a client island (or a
/// streaming shell) needs it, each client island's code, the live runtime for a live island. The
/// sizes are a dev estimate: each group's modules (static imports, dependencies included; an
/// island doesn't count the runtime's again) through the dev browser transform and the minifier,
/// gzipped together. Builds split and hoist differently, so the build's own figure is shown next
/// to it when `dist/route-js.json` has one.
fn page_js(
    core: &nowaki_core::NowakiCore,
    route: &Path,
    layouts: &[PathBuf],
    streaming: bool,
    runtime: Option<&Path>,
) -> PageJs {
    let root = &core.root;
    let routes_dir = root.join("routes");
    let islands_dir = root.join("islands");
    let rel = route
        .strip_prefix(&routes_dir)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let mut reach: HashSet<PathBuf> = nowaki_core::chunk::collect_app_modules(core, route);
    for wrapper in layouts
        .iter()
        .cloned()
        .chain(nowaki_core::budget::slot_files_for(&routes_dir, &rel))
    {
        reach.extend(nowaki_core::chunk::collect_app_modules(core, &wrapper));
    }
    let mut found: Vec<PathBuf> = reach
        .into_iter()
        .filter(|m| m.parent() == Some(islands_dir.as_path()) && nowaki_core::is_transformable(m))
        .collect();
    found.sort();

    let runtime_mods = runtime
        .map(|d| module_closure(core, &d.join("islands.js"), &HashSet::new()))
        .unwrap_or_default();
    let runtime_set: HashSet<PathBuf> = runtime_mods.iter().cloned().collect();
    let hints = hints_enabled();
    let mut islands = Vec::new();
    let mut island_bytes = 0u64;
    let (mut any_client, mut any_live) = (false, false);
    for path in &found {
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let source = core.read_source(path).unwrap_or_default();
        let live = nowaki_core::live_hint::exports_live(path, &source);
        let mut entry = json!({
            "name": name,
            "file": rel_path(root, path),
            "kind": if live { "live" } else { "client" },
        });
        if live {
            // Rendered on the server: no component JS.
            any_live = true;
            entry["gzipBytes"] = json!(0);
        } else {
            any_client = true;
            let bytes = group_gzip(core, &module_closure(core, path, &runtime_set));
            island_bytes += bytes;
            entry["gzipBytes"] = json!(bytes);
            if hints {
                if let Some(h) = nowaki_core::live_hint::hint_for_island(path, &source) {
                    entry["hint"] = json!({
                        "kind": match h.kind {
                            nowaki_core::live_hint::HintKind::CouldBeLive => "could-be-live",
                            nowaki_core::live_hint::HintKind::NoInteractivity => "no-interactivity",
                        },
                        "uses": h.uses,
                    });
                }
            }
        }
        islands.push(entry);
    }
    let runtime_bytes = runtime
        .filter(|_| any_client || streaming)
        .map(|_| group_gzip(core, &runtime_mods));
    let live_bytes = runtime.filter(|_| any_live).map(|d| {
        group_gzip(
            core,
            &module_closure(core, &d.join("live.js"), &HashSet::new()),
        )
    });
    let total = island_bytes + runtime_bytes.unwrap_or(0) + live_bytes.unwrap_or(0);
    let budget_kb = core.read_source(route).ok().and_then(|src| {
        nowaki_core::budget::parse_budget(route, &src)
            .ok()
            .flatten()
    });
    PageJs {
        islands: Value::Array(islands),
        js: json!({
            "estimate": {
                "label": "estimate",
                "gzipBytes": total,
                "runtime": runtime_bytes,
                "liveRuntime": live_bytes,
                "islands": island_bytes,
            },
            "budgetKB": budget_kb,
            "lastBuild": last_build(root, &rel_path(root, route)),
        }),
    }
}

/// The route's figure from the last `nowaki build` (`dist/route-js.json`), with the file's time.
fn last_build(root: &Path, route_rel: &str) -> Option<Value> {
    let file = root.join("dist/route-js.json");
    let list: Value = serde_json::from_str(&std::fs::read_to_string(&file).ok()?).ok()?;
    let r = list.as_array()?.iter().find(|r| r["file"] == route_rel)?;
    let built = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
    Some(json!({
        "gzipBytes": r["gzipBytes"],
        "budgetKB": r["budgetKB"],
        "builtAt": built.map(rfc3339),
    }))
}

/// `entry` and what it imports statically (dependencies included), minus `skip`, sorted. Dynamic
/// imports load later, so they aren't first-load JS; CSS and assets aren't JS.
fn module_closure(
    core: &nowaki_core::NowakiCore,
    entry: &Path,
    skip: &HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut stack = vec![entry.to_path_buf()];
    while let Some(abs) = stack.pop() {
        if skip.contains(&abs) || !nowaki_core::is_transformable(&abs) || !seen.insert(abs.clone())
        {
            continue;
        }
        for i in nowaki_core::graph::module_imports(core, &abs).unwrap_or_default() {
            if let (false, Some(p)) = (i.dynamic, i.resolved) {
                stack.push(p);
            }
        }
    }
    let mut out: Vec<PathBuf> = seen.into_iter().collect();
    out.sort();
    out
}

/// gzip (level 9) of the modules' minified browser code, concatenated.
fn group_gzip(core: &nowaki_core::NowakiCore, mods: &[PathBuf]) -> u64 {
    if mods.is_empty() {
        return 0;
    }
    let mut all = String::new();
    for m in mods {
        if let Some(code) = minified(core, m) {
            all.push_str(&code);
            all.push('\n');
        }
    }
    nowaki_core::compress::gzip(all.as_bytes(), 9).len() as u64
}

/// Minified browser code per module, keyed by the dev transform's output: a module is minified
/// again only when its code changed (a new file version, a hot version).
type MinifiedCache = Mutex<HashMap<PathBuf, (u64, Arc<str>)>>;
static MINIFIED: OnceLock<MinifiedCache> = OnceLock::new();

fn minified(core: &nowaki_core::NowakiCore, abs: &Path) -> Option<Arc<str>> {
    let code = core.load_module(abs, nowaki_core::Mode::Browser).ok()?;
    let hash = xxhash_rust::xxh3::xxh3_64(code.as_bytes());
    let cache = MINIFIED.get_or_init(Default::default);
    if let Some((h, m)) = cache.lock().unwrap().get(abs) {
        if *h == hash {
            return Some(m.clone());
        }
    }
    let name = abs.file_name()?.to_string_lossy().into_owned();
    let min: Arc<str> = nowaki_core::chunk::minify_chunk(&name, &code)
        .map(|(c, _)| c)
        .unwrap_or(code)
        .into();
    cache
        .lock()
        .unwrap()
        .insert(abs.to_path_buf(), (hash, min.clone()));
    Some(min)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
    }

    fn reply(step: Step) -> Value {
        match step {
            Step::Reply(v) => v,
            other => panic!("expected a reply, got {other:?}"),
        }
    }

    #[test]
    fn initialize_negotiates_the_protocol_version() {
        let r = reply(route(&req(
            "initialize",
            json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }),
        )));
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "nowaki-dev");
        assert!(r["result"]["capabilities"]["tools"].is_object());

        let r = reply(route(&req(
            "initialize",
            json!({ "protocolVersion": "1999-01-01" }),
        )));
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn tools_list_names_every_tool_with_a_schema() {
        let r = reply(route(&req("tools/list", json!({}))));
        let tools = r["result"]["tools"].as_array().unwrap();
        let names: Vec<_> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, TOOLS);
        for t in tools {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert_eq!(t["annotations"]["readOnlyHint"], true);
        }
    }

    #[test]
    fn tools_call_routes_known_tools_and_rejects_unknown() {
        let step = route(&req(
            "tools/call",
            json!({ "name": "recent_errors", "arguments": { "limit": 3 } }),
        ));
        assert_eq!(
            step,
            Step::Call {
                id: json!(1),
                name: "recent_errors".into(),
                args: json!({ "limit": 3 })
            }
        );
        let r = reply(route(&req("tools/call", json!({ "name": "nope" }))));
        assert_eq!(r["error"]["code"], -32602);
        let r = reply(route(&req(
            "tools/call",
            json!({ "name": "routes", "arguments": [1] }),
        )));
        assert_eq!(r["error"]["code"], -32602);
    }

    #[test]
    fn notifications_and_responses_get_no_reply() {
        let n = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(route(&n), Step::Accepted);
        let resp = json!({ "jsonrpc": "2.0", "id": 9, "result": {} });
        assert_eq!(route(&resp), Step::Accepted);
    }

    #[test]
    fn malformed_requests_get_jsonrpc_errors() {
        let r = reply(route(&req("bogus/method", json!({}))));
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["id"], 1);
        let r = reply(route(&json!({ "id": 2, "method": "ping" })));
        assert_eq!(r["error"]["code"], -32600);
        assert_eq!(r["id"], 2);
        let r = reply(route(
            &json!({ "jsonrpc": "2.0", "id": null, "method": "ping" }),
        ));
        assert_eq!(r["error"]["code"], -32600);
        let r = reply(route(&json!("ping")));
        assert_eq!(r["error"]["code"], -32600);
        let r = reply(route(&req("ping", json!({}))));
        assert_eq!(r["result"], json!({}));
    }

    fn hdrs(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn only_loopback_peers_hosts_and_origins_are_allowed() {
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let lo6: IpAddr = "::1".parse().unwrap();
        let mapped: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        let lan: IpAddr = "192.168.1.10".parse().unwrap();
        let ok_host = hdrs(&[("host", "127.0.0.1:3007")]);
        assert!(request_allowed(lo, &ok_host));
        assert!(request_allowed(lo6, &hdrs(&[("host", "[::1]:3007")])));
        assert!(request_allowed(mapped, &ok_host));
        assert!(request_allowed(lo, &hdrs(&[("host", "localhost:3007")])));
        // --host: a LAN peer is refused even with a loopback Host header
        assert!(!request_allowed(lan, &ok_host));
        // DNS rebinding: loopback peer, attacker hostname
        assert!(!request_allowed(
            lo,
            &hdrs(&[("host", "attacker.test:3007")])
        ));
        assert!(!request_allowed(lo, &HeaderMap::new()));
        // Browser on another site
        assert!(!request_allowed(
            lo,
            &hdrs(&[("host", "127.0.0.1:3007"), ("origin", "http://evil.test")])
        ));
        assert!(!request_allowed(
            lo,
            &hdrs(&[("host", "127.0.0.1:3007"), ("origin", "null")])
        ));
        assert!(request_allowed(
            lo,
            &hdrs(&[
                ("host", "127.0.0.1:3007"),
                ("origin", "http://localhost:3007")
            ])
        ));
    }

    #[test]
    fn error_log_keeps_the_newest_fifty() {
        let log = ErrorLog::new(Path::new("/app"));
        for i in 0..60 {
            log.record("build", &format!("e{i}"), None, None, None);
        }
        log.record("ssr", "boom", None, Some("/boom".into()), None);
        let (all, stored) = log.recent(100, None);
        assert_eq!(stored, MAX_ERRORS);
        assert_eq!(all.len(), MAX_ERRORS);
        assert_eq!(all[0].message, "boom");
        assert_eq!(all.last().unwrap().message, "e11");
        let (ssr, _) = log.recent(10, Some("ssr"));
        assert_eq!(ssr.len(), 1);
        assert_eq!(ssr[0].path.as_deref(), Some("/boom"));
    }

    #[test]
    fn sidecar_error_lines_need_the_token() {
        let log = ErrorLog::new(Path::new("/app"));
        assert!(!log
            .handle_sidecar_line("NOWAKI_DEV_ERROR wrong {\"source\":\"ssr\",\"message\":\"x\"}"));
        assert!(!log.handle_sidecar_line("hello"));
        let line = format!(
            "NOWAKI_DEV_ERROR {} {}",
            crate::live::publish_token(),
            json!({ "source": "ssr", "message": "kaput", "stack": "Error: kaput\n    at Page (file:///app/routes/boom.tsx?v=4:7:11)\n    at x (file:///app/node_modules/preact/a.js:1:1)", "path": "/boom" })
        );
        assert!(log.handle_sidecar_line(&line));
        let (e, _) = log.recent(1, None);
        assert_eq!(e[0].message, "kaput");
        assert_eq!(e[0].file.as_deref(), Some("routes/boom.tsx:7:11"));
    }

    #[test]
    fn stack_file_skips_dependencies_and_decodes() {
        let root = Path::new("/app");
        let s = "Error: x\n    at a (file:///app/node_modules/x/y.js:1:2)\n    at b (file:///app/routes/blog/%5Bslug%5D.tsx:3:4)";
        assert_eq!(
            stack_file(root, s).as_deref(),
            Some("routes/blog/[slug].tsx:3:4")
        );
        // source-mapped frames are plain paths
        let s = "Error: y\n    at Module.loader (/app/routes/boom.tsx:10:19)\n    at /app/lib/db.ts:2:3";
        assert_eq!(
            stack_file(root, s).as_deref(),
            Some("routes/boom.tsx:10:19")
        );
        assert_eq!(
            stack_file(root, "    at /app/lib/db.ts:2:3").as_deref(),
            Some("lib/db.ts:2:3")
        );
        assert_eq!(stack_file(root, "    at c (node:internal/x:1:1)"), None);
    }

    #[test]
    fn timestamps_are_rfc3339_utc() {
        let t = UNIX_EPOCH + std::time::Duration::from_millis(1_762_214_400_123);
        assert_eq!(rfc3339(t), "2025-11-04T00:00:00.123Z");
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn tools_list_has_page_and_live() {
        let r = reply(route(&req("tools/list", json!({}))));
        let tools = r["result"]["tools"].as_array().unwrap();
        let page = tools.iter().find(|t| t["name"] == "page").unwrap();
        assert_eq!(page["inputSchema"]["required"], json!(["url"]));
        assert!(tools.iter().any(|t| t["name"] == "live"));
        let step = route(&req(
            "tools/call",
            json!({ "name": "page", "arguments": { "url": "/" } }),
        ));
        assert!(matches!(step, Step::Call { ref name, .. } if name == "page"));
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn page_js_lists_the_routes_islands_and_its_budget() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        write(
            &root,
            "routes/_layout.tsx",
            "import Badge from \"../islands/Badge.tsx\";\nexport default function L({ children }: { children: unknown }) { return <div><Badge />{children}</div>; }\n",
        );
        write(
            &root,
            "routes/index.tsx",
            "import Counter from \"../islands/Counter.tsx\";\nimport Ticker from \"../islands/Ticker.tsx\";\nexport const budget = { js: 12 };\nexport default function Home() { return <main><Counter /><Ticker /></main>; }\n",
        );
        write(
            &root,
            "routes/other.tsx",
            "import Unused from \"../islands/Unused.tsx\";\nexport default function O() { return <Unused />; }\n",
        );
        write(
            &root,
            "islands/Counter.tsx",
            "import { useState } from \"preact/hooks\";\nexport default function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }\n",
        );
        write(
            &root,
            "lib/label.ts",
            "export const label = (n: number) => `count: ${n} ${\"x\".repeat(40)}`;\n",
        );
        write(
            &root,
            "islands/Badge.tsx",
            "import { label } from \"../lib/label.ts\";\nexport default function Badge() { return <b>{label(1)}</b>; }\n",
        );
        write(
            &root,
            "islands/Ticker.tsx",
            "export const live = { state: () => ({ n: 0 }) };\nexport default function Ticker({ state }: { state: { n: number } }) { return <i>{state.n}</i>; }\n",
        );
        write(
            &root,
            "islands/Unused.tsx",
            "export default function Unused() { return <u />; }\n",
        );
        write(
            &root,
            "dist/route-js.json",
            r#"[{ "url": "/", "file": "routes/index.tsx", "gzipBytes": 4321, "budgetKB": 12 }]"#,
        );
        let core = nowaki_core::NowakiCore::new(root.clone());
        let js = page_js(
            &core,
            &root.join("routes/index.tsx"),
            &[root.join("routes/_layout.tsx")],
            false,
            None,
        );
        let islands = js.islands.as_array().unwrap();
        let names: Vec<_> = islands
            .iter()
            .map(|i| i["name"].as_str().unwrap())
            .collect();
        // The layout's island counts; another route's doesn't.
        assert_eq!(names, ["Badge", "Counter", "Ticker"]);
        let by = |n: &str| islands.iter().find(|i| i["name"] == n).unwrap();
        assert_eq!(by("Counter")["kind"], "client");
        assert_eq!(by("Counter")["file"], "islands/Counter.tsx");
        assert_eq!(by("Counter")["hint"]["kind"], "could-be-live");
        // Imports an app module, which the hint doesn't follow: no hint.
        assert!(by("Badge").get("hint").is_none());
        assert_eq!(by("Ticker")["kind"], "live");
        assert_eq!(by("Ticker")["gzipBytes"], 0);
        assert!(by("Ticker").get("hint").is_none());
        let counter = by("Counter")["gzipBytes"].as_u64().unwrap();
        let badge = by("Badge")["gzipBytes"].as_u64().unwrap();
        assert!(counter > 0 && badge > 0, "{counter} {badge}");
        // The util the island imports is part of its estimate.
        let alone = group_gzip(&core, &[root.join("islands/Badge.tsx")]);
        assert!(badge > alone, "{badge} {alone}");
        assert_eq!(js.js["estimate"]["label"], "estimate");
        assert_eq!(
            js.js["estimate"]["gzipBytes"].as_u64().unwrap(),
            counter + badge
        );
        // No runtime package installed here.
        assert!(js.js["estimate"]["runtime"].is_null());
        assert_eq!(js.js["budgetKB"], 12.0);
        assert_eq!(js.js["lastBuild"]["gzipBytes"], 4321);
        assert!(js.js["lastBuild"]["builtAt"].is_string());

        // Without a build, there is no last figure; a page without islands ships nothing.
        std::fs::remove_file(root.join("dist/route-js.json")).unwrap();
        write(
            &root,
            "routes/plain.tsx",
            "export default function P() { return <p />; }\n",
        );
        let js = page_js(&core, &root.join("routes/plain.tsx"), &[], false, None);
        assert_eq!(js.islands, json!([]));
        assert_eq!(js.js["estimate"]["gzipBytes"], 0);
        assert!(js.js["lastBuild"].is_null());
        assert!(js.js["budgetKB"].is_null());
    }

    #[test]
    fn module_closure_follows_static_imports_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        write(
            &root,
            "a.ts",
            "import \"./b.ts\";\nimport \"./x.css\";\nexport const a = () => import(\"./c.ts\");\n",
        );
        write(
            &root,
            "b.ts",
            "import { d } from \"./d.ts\";\nexport const b = d;\n",
        );
        write(&root, "c.ts", "export const c = 1;\n");
        write(&root, "d.ts", "export const d = 1;\n");
        write(&root, "x.css", "a{}\n");
        let core = nowaki_core::NowakiCore::new(root.clone());
        let names = |v: Vec<PathBuf>| v.iter().map(|p| rel_path(&root, p)).collect::<Vec<_>>();
        assert_eq!(
            names(module_closure(&core, &root.join("a.ts"), &HashSet::new())),
            ["a.ts", "b.ts", "d.ts"]
        );
        let skip: HashSet<PathBuf> = [root.join("b.ts")].into_iter().collect();
        assert_eq!(
            names(module_closure(&core, &root.join("a.ts"), &skip)),
            ["a.ts"]
        );
    }

    #[test]
    fn editor_templates_are_known_names_or_safe_urls() {
        assert_eq!(
            editor_template("").as_deref(),
            Some("vscode://file/{file}:{line}:{column}")
        );
        assert_eq!(
            editor_template("Cursor").as_deref(),
            Some("cursor://file/{file}:{line}:{column}")
        );
        assert_eq!(
            editor_template("zed").as_deref(),
            Some("zed://file/{file}:{line}:{column}")
        );
        assert_eq!(
            editor_template("subl://open?url=file://{file}&line={line}").as_deref(),
            Some("subl://open?url=file://{file}&line={line}")
        );
        assert_eq!(editor_template("javascript:alert('{file}')"), None);
        assert_eq!(editor_template("JavaScript:x({file})"), None);
        assert_eq!(editor_template("data:text/html,{file}"), None);
        assert_eq!(editor_template("vim"), None);
        assert_eq!(editor_template("off"), None);
        assert_eq!(editor_template("myeditor://open"), None);
    }
}
