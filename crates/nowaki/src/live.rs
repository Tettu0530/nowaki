//! WS session for server-reactive islands (Jetstream). Shared by dev and prod.
//!
//! State lives on the Rust side (this connection) as nid→(name, state); the Node sidecar's
//! `/__nowaki/live-render` is a pure re-evaluation function. The resulting html is pushed as a `patch`.
//!
//! One render runs at a time per connection (each island's state chain stays ordered), off the
//! select loop, so pings, presence, and new messages keep flowing while the sidecar works.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use serde_json::{json, Value};
use tokio::sync::broadcast;

/// Heartbeat interval and idle timeout (disconnect if no pong/message within it).
const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
/// Events waiting behind the in-flight render; more are answered with `busy` and dropped.
const MAX_QUEUED: usize = 32;

fn render_timeout() -> Duration {
    let ms = std::env::var("NOWAKI_LIVE_RENDER_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n: &u64| n > 0)
        .unwrap_or(10_000);
    Duration::from_millis(ms)
}

/// nid -> (island name, current state, state signature)
type Islands = HashMap<String, (String, Value, String)>;

struct PendingEvent {
    nid: String,
    handler: Value,
    payload: Value,
}

/// FIFO of events behind the in-flight render, capped at `max`.
struct EventQueue {
    items: VecDeque<PendingEvent>,
    max: usize,
}

impl EventQueue {
    fn new(max: usize) -> Self {
        Self {
            items: VecDeque::new(),
            max,
        }
    }

    /// Err(nid) when full: the event is dropped.
    fn push(&mut self, ev: PendingEvent) -> Result<(), String> {
        if self.items.len() >= self.max {
            return Err(ev.nid);
        }
        self.items.push_back(ev);
        Ok(())
    }

    fn pop(&mut self) -> Option<PendingEvent> {
        self.items.pop_front()
    }
}

#[derive(Debug, PartialEq)]
enum RenderError {
    Timeout,
    Failed,
    Forbidden,
}

impl RenderError {
    fn reason(&self) -> &'static str {
        match self {
            RenderError::Timeout => "timeout",
            RenderError::Failed => "render failed",
            RenderError::Forbidden => "forbidden",
        }
    }
}

struct Rendered {
    nid: String,
    name: String,
    result: Result<(String, Option<Value>, String), RenderError>,
}

/// Hub for all connections. Enforces the concurrent connection cap and broadcasts presence (connection count).
pub struct LiveHub {
    active: AtomicUsize,
    max: usize,
    presence: broadcast::Sender<usize>,
}

impl LiveHub {
    pub fn new() -> Arc<Self> {
        let max = std::env::var("NOWAKI_LIVE_MAX")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&n| n > 0)
            .unwrap_or(10_000);
        let (presence, _) = broadcast::channel(64);
        Arc::new(Self {
            active: AtomicUsize::new(0),
            max,
            presence,
        })
    }

    /// Accept one connection. None if over the cap (the caller rejects it).
    fn join(&self) -> Option<usize> {
        let prev = self.active.fetch_add(1, Ordering::SeqCst);
        if prev + 1 > self.max {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        let n = prev + 1;
        let _ = self.presence.send(n);
        Some(n)
    }

    fn leave(&self) {
        let prev = self.active.fetch_sub(1, Ordering::SeqCst);
        let _ = self.presence.send(prev.saturating_sub(1));
    }

    fn count(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }
}

/// Upgrade request headers live handlers may read through getContext(). Captured once per
/// connection; the sidecar never sees client-sent forwarding or internal headers.
const CONTEXT_HEADERS: [&str; 4] = ["cookie", "authorization", "accept-language", "user-agent"];

pub fn context_headers(headers: &axum::http::HeaderMap) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    for name in CONTEXT_HEADERS {
        if let Some(v) = headers.get(name).and_then(|v| v.to_str().ok()) {
            m.insert(name.to_string(), Value::String(v.to_string()));
        }
    }
    let trust = crate::forward::trust_proxy();
    if let Some(host) = crate::forward::public_host(headers, trust) {
        m.insert("x-forwarded-host".into(), Value::String(host));
    }
    m.insert(
        "x-forwarded-proto".into(),
        Value::String(crate::forward::public_proto(headers, trust).into()),
    );
    m
}

pub async fn handle(
    mut socket: WebSocket,
    hub: Arc<LiveHub>,
    http: reqwest::Client,
    sidecar_port: u16,
    version: String,
    request_headers: serde_json::Map<String, Value>,
) {
    // Over the cap: send an error, then close (the client degrades to the initial SSR).
    let Some(count) = hub.join() else {
        let _ = socket
            .send(Message::Text(
                json!({ "type": "error", "reason": "at capacity" })
                    .to_string()
                    .into(),
            ))
            .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    };

    let mut presence_rx = hub.presence.subscribe();
    let _ = socket
        .send(Message::Text(
            json!({ "type": "presence", "count": count })
                .to_string()
                .into(),
        ))
        .await;

    let mut islands: Islands = HashMap::new();
    let mut queue = EventQueue::new(MAX_QUEUED);
    let mut inflight: Option<tokio::task::JoinHandle<Rendered>> = None;
    let ctx = RenderCtx {
        http,
        sidecar_port,
        version,
        timeout: render_timeout(),
        request: Arc::new(json!({ "headers": request_headers })),
    };
    let mut last_seen = Instant::now();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await; // discard the immediate first tick

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                last_seen = Instant::now(); // any received message (incl. pong) marks liveness
                if let Message::Text(txt) = msg {
                    if let Some(Err(nid)) = handle_text(&mut islands, txt.as_str()).map(|ev| queue.push(ev)) {
                        if !send_error(&mut socket, &nid, "busy").await {
                            break;
                        }
                    }
                }
                // Ping/Pong/Binary/Close only update last_seen (Close makes recv return None).
            }
            done = async { inflight.as_mut().unwrap().await }, if inflight.is_some() => {
                inflight = None;
                let Ok(r) = done else { continue };
                if !apply_rendered(&mut socket, &mut islands, r).await {
                    break;
                }
            }
            p = presence_rx.recv() => {
                let n = match p {
                    Ok(n) => n,
                    Err(broadcast::error::RecvError::Lagged(_)) => hub.count(),
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if socket.send(Message::Text(json!({ "type": "presence", "count": n }).to_string().into())).await.is_err() {
                    break;
                }
            }
            _ = ping.tick() => {
                if last_seen.elapsed() > IDLE_TIMEOUT {
                    break;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
        if inflight.is_none() {
            while let Some(ev) = queue.pop() {
                if let Some((name, st, sig)) = islands.get(&ev.nid).cloned() {
                    inflight = Some(tokio::spawn(render(ctx.clone(), ev, name, st, sig)));
                    break;
                }
            }
        }
    }

    if let Some(h) = inflight {
        h.abort();
    }
    hub.leave();
}

#[derive(Clone)]
struct RenderCtx {
    http: reqwest::Client,
    sidecar_port: u16,
    version: String,
    timeout: Duration,
    request: Arc<Value>,
}

/// Handle a Text message: `join` registers islands; `event` returns the event to queue.
fn handle_text(islands: &mut Islands, txt: &str) -> Option<PendingEvent> {
    let v = serde_json::from_str::<Value>(txt).ok()?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("join") => {
            if let Some(arr) = v.get("islands").and_then(|i| i.as_array()) {
                for it in arr {
                    let nid = it.get("nid").and_then(|x| x.as_str()).unwrap_or("");
                    if nid.is_empty() {
                        continue;
                    }
                    let name = it
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let st = it.get("state").cloned().unwrap_or_else(|| json!({}));
                    // Signature of the initial state (issued at SSR). The sidecar verifies it before running handlers.
                    let sig = it
                        .get("sig")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    islands.insert(nid.to_string(), (name, st, sig));
                }
            }
            None
        }
        Some("event") => {
            let nid = v.get("nid").and_then(|x| x.as_str()).unwrap_or("");
            if !islands.contains_key(nid) {
                return None;
            }
            Some(PendingEvent {
                nid: nid.to_string(),
                handler: v.get("handler").cloned().unwrap_or(Value::Null),
                payload: v.get("payload").cloned().unwrap_or(Value::Null),
            })
        }
        _ => None,
    }
}

async fn render(
    ctx: RenderCtx,
    ev: PendingEvent,
    name: String,
    st: Value,
    sig: String,
) -> Rendered {
    let body = json!({
        "name": name,
        "state": st,
        "sig": sig,
        "handler": ev.handler,
        "payload": ev.payload,
        "version": ctx.version,
        "request": *ctx.request,
    });
    let url = format!("http://127.0.0.1:{}/__nowaki/live-render", ctx.sidecar_port);
    let call = async {
        let r = ctx
            .http
            .post(&url)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| RenderError::Failed)?;
        if r.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(RenderError::Forbidden);
        }
        let rv: Value = serde_json::from_str(&r.text().await.map_err(|_| RenderError::Failed)?)
            .map_err(|_| RenderError::Failed)?;
        // No html (e.g. a failed signature check): never keep forged state or send an empty render.
        let html = rv
            .get("html")
            .and_then(|h| h.as_str())
            .ok_or(RenderError::Failed)?
            .to_string();
        let nsig = rv
            .get("sig")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        Ok((html, rv.get("state").cloned(), nsig))
    };
    let result = match tokio::time::timeout(ctx.timeout, call).await {
        Ok(r) => r,
        Err(_) => Err(RenderError::Timeout),
    };
    Rendered {
        nid: ev.nid,
        name,
        result,
    }
}

/// Store the new state and push the patch, or tell the client the event failed.
/// false when the socket is gone.
async fn apply_rendered(socket: &mut WebSocket, islands: &mut Islands, r: Rendered) -> bool {
    let (html, new_state, nsig) = match r.result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[nowaki live] {} re-render {}", r.name, e.reason());
            return send_error(socket, &r.nid, e.reason()).await;
        }
    };
    // Keep the new signature too so the next event can be verified.
    if let Some(ns) = new_state {
        islands.insert(r.nid.clone(), (r.name, ns, nsig));
    }
    let Some((_, st, sig)) = islands.get(&r.nid) else {
        return true;
    };
    // The client stores state+sig on the element so a re-join after a reconnect resumes here.
    let patch = json!({ "type": "patch", "nid": r.nid, "html": html, "state": st, "sig": sig });
    socket
        .send(Message::Text(patch.to_string().into()))
        .await
        .is_ok()
}

async fn send_error(socket: &mut WebSocket, nid: &str, reason: &str) -> bool {
    let msg = json!({ "type": "error", "nid": nid, "reason": reason });
    socket
        .send(Message::Text(msg.to_string().into()))
        .await
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(nid: &str) -> PendingEvent {
        PendingEvent {
            nid: nid.into(),
            handler: json!("inc"),
            payload: Value::Null,
        }
    }

    #[test]
    fn queue_is_fifo_and_capped() {
        let mut q = EventQueue::new(2);
        assert!(q.push(ev("a")).is_ok());
        assert!(q.push(ev("b")).is_ok());
        assert_eq!(q.push(ev("c")), Err("c".into()), "over the cap");
        assert_eq!(q.pop().map(|e| e.nid), Some("a".into()));
        assert_eq!(q.pop().map(|e| e.nid), Some("b".into()));
        assert!(q.pop().is_none());
    }

    #[test]
    fn join_registers_and_event_needs_a_known_island() {
        let mut islands = Islands::new();
        let join = r#"{"type":"join","islands":[{"nid":"L0","name":"LiveCounter","state":{"count":1},"sig":"s"},{"nid":"","name":"x"}]}"#;
        assert!(handle_text(&mut islands, join).is_none());
        assert_eq!(islands.len(), 1);
        assert_eq!(islands["L0"].1, json!({"count": 1}));

        let e = handle_text(
            &mut islands,
            r#"{"type":"event","nid":"L0","handler":"inc"}"#,
        )
        .unwrap();
        assert_eq!(e.nid, "L0");
        assert_eq!(e.handler, json!("inc"));
        assert!(handle_text(
            &mut islands,
            r#"{"type":"event","nid":"L9","handler":"inc"}"#
        )
        .is_none());
        assert!(handle_text(&mut islands, "not json").is_none());
    }

    #[test]
    fn error_reasons_are_generic() {
        assert_eq!(RenderError::Timeout.reason(), "timeout");
        assert_eq!(RenderError::Failed.reason(), "render failed");
        assert_eq!(RenderError::Forbidden.reason(), "forbidden");
    }

    #[test]
    fn context_headers_keep_only_the_allowlist() {
        let mut h = axum::http::HeaderMap::new();
        for (k, v) in [
            ("cookie", "user=alice"),
            ("user-agent", "t"),
            ("host", "app.example"),
            ("x-forwarded-host", "evil.test"),
            ("x-nowaki-page", "1"),
            ("sec-websocket-key", "k"),
        ] {
            h.insert(axum::http::HeaderName::from_static(k), v.parse().unwrap());
        }
        let m = context_headers(&h);
        assert_eq!(m["cookie"], "user=alice");
        assert_eq!(m["user-agent"], "t");
        assert_eq!(m["x-forwarded-host"], "app.example");
        assert_eq!(m["x-forwarded-proto"], "http");
        assert!(!m.contains_key("x-nowaki-page") && !m.contains_key("sec-websocket-key"));
    }
}
