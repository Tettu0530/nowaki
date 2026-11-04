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

/// nid -> (island name, current state, state signature, subscribed topics)
type Islands = HashMap<String, (String, Value, String, Vec<String>)>;

/// Topics an island listens to (`live.subscribe`), capped so a client can't make one huge list.
const MAX_TOPICS: usize = 16;
const MAX_TOPIC_LEN: usize = 128;

pub fn parse_topics(v: Option<&Value>) -> Vec<String> {
    let Some(arr) = v.and_then(|t| t.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|t| t.as_str())
        .filter(|t| !t.is_empty() && t.len() <= MAX_TOPIC_LEN)
        .take(MAX_TOPICS)
        .map(str::to_string)
        .collect()
}

/// Random per process; only the sidecars Nowaki spawned get it (NOWAKI_PUBLISH_TOKEN), so a log
/// line can't be mistaken for a publish.
pub fn publish_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(crate::csp::new_nonce)
}

/// Called for every sidecar stdout line. `NOWAKI_PUBLISH <token> <topic>` is a `publish(topic)`
/// from server code (consumed, returns true); anything else is a log line.
pub fn handle_sidecar_line(hub: &LiveHub, line: &str) -> bool {
    let Some(rest) = line.strip_prefix("NOWAKI_PUBLISH ") else {
        return false;
    };
    let Some((token, topic)) = rest.split_once(' ') else {
        return false;
    };
    if token != publish_token() {
        return false;
    }
    let topic = topic.trim();
    if !topic.is_empty() && topic.len() <= MAX_TOPIC_LEN {
        let _ = hub.topics.send(topic.to_string());
    }
    true
}

struct PendingEvent {
    nid: String,
    handler: Value,
    payload: Value,
    /// A `publish(topic)` refresh: runs `live.load` instead of a handler.
    load: Option<String>,
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

    /// A refresh already waiting for this island covers another publish.
    fn has_load(&self, nid: &str) -> bool {
        self.items.iter().any(|e| e.load.is_some() && e.nid == nid)
    }
}

#[derive(Debug, PartialEq)]
enum RenderError {
    Timeout,
    Failed,
    Forbidden,
    /// The signature is genuine but past NOWAKI_LIVE_MAX_AGE; the client reloads the page.
    Stale,
}

impl RenderError {
    fn reason(&self) -> &'static str {
        match self {
            RenderError::Timeout => "timeout",
            RenderError::Failed => "render failed",
            RenderError::Forbidden => "forbidden",
            RenderError::Stale => "stale",
        }
    }
}

struct RenderOk {
    html: String,
    state: Option<Value>,
    sig: String,
    /// Present when the render reported the island's topics (`live.subscribe`).
    topics: Option<Vec<String>>,
}

struct Rendered {
    nid: String,
    name: String,
    result: Result<RenderOk, RenderError>,
}

/// Hub for all connections. Enforces the concurrent connection cap and broadcasts presence (connection count).
pub struct LiveHub {
    active: AtomicUsize,
    max: usize,
    presence: broadcast::Sender<usize>,
    /// `publish(topic)` from the sidecar, fanned out to every session in this process.
    topics: broadcast::Sender<String>,
    /// Connections per room (sessions with an island subscribed to `room:<id>`), and its changes.
    rooms: std::sync::Mutex<HashMap<String, usize>>,
    room_presence: broadcast::Sender<(String, usize)>,
}

impl LiveHub {
    pub fn new() -> Arc<Self> {
        let max = std::env::var("NOWAKI_LIVE_MAX")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&n| n > 0)
            .unwrap_or(10_000);
        let (presence, _) = broadcast::channel(64);
        let (topics, _) = broadcast::channel(256);
        let (room_presence, _) = broadcast::channel(256);
        Arc::new(Self {
            active: AtomicUsize::new(0),
            max,
            presence,
            topics,
            rooms: std::sync::Mutex::new(HashMap::new()),
            room_presence,
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

    fn room_enter(&self, room: &str) {
        let n = {
            let mut m = self.rooms.lock().unwrap();
            let c = m.entry(room.to_string()).or_insert(0);
            *c += 1;
            *c
        };
        let _ = self.room_presence.send((room.to_string(), n));
    }

    fn room_exit(&self, room: &str) {
        let n = {
            let mut m = self.rooms.lock().unwrap();
            let Some(c) = m.get_mut(room) else { return };
            *c = c.saturating_sub(1);
            let n = *c;
            if n == 0 {
                m.remove(room);
            }
            n
        };
        let _ = self.room_presence.send((room.to_string(), n));
    }

    fn room_count(&self, room: &str) -> usize {
        self.rooms.lock().unwrap().get(room).copied().unwrap_or(0)
    }
}

/// Rooms this session is in: its islands' `room:<id>` topics.
fn rooms_of(islands: &Islands) -> std::collections::HashSet<String> {
    islands
        .values()
        .flat_map(|(_, _, _, topics)| topics.iter())
        .filter_map(|t| t.strip_prefix("room:"))
        .map(str::to_string)
        .collect()
}

/// Enter rooms the session joined and leave the ones it no longer has an island in.
fn sync_rooms(hub: &LiveHub, mine: &mut std::collections::HashSet<String>, islands: &Islands) {
    let now = rooms_of(islands);
    for r in mine.difference(&now) {
        hub.room_exit(r);
    }
    for r in now.difference(mine) {
        hub.room_enter(r);
    }
    *mine = now;
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
    let mut topic_rx = hub.topics.subscribe();
    let mut room_rx = hub.room_presence.subscribe();
    let mut my_rooms = std::collections::HashSet::new();
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
                    sync_rooms(&hub, &mut my_rooms, &islands);
                }
                // Ping/Pong/Binary/Close only update last_seen (Close makes recv return None).
            }
            done = async { inflight.as_mut().unwrap().await }, if inflight.is_some() => {
                inflight = None;
                let Ok(r) = done else { continue };
                if !apply_rendered(&mut socket, &mut islands, r).await {
                    break;
                }
                sync_rooms(&hub, &mut my_rooms, &islands);
            }
            t = topic_rx.recv() => {
                let topic = match t {
                    Ok(t) => t,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                for (nid, (_, _, _, topics)) in &islands {
                    if topics.contains(&topic) && !queue.has_load(nid) {
                        // A full queue drops the refresh; the next publish or event catches up.
                        let _ = queue.push(PendingEvent {
                            nid: nid.clone(),
                            handler: Value::Null,
                            payload: Value::Null,
                            load: Some(topic.clone()),
                        });
                    }
                }
            }
            rp = room_rx.recv() => {
                let (room, n) = match rp {
                    Ok(v) => v,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if my_rooms.contains(&room) {
                    let n = if n == 0 { hub.room_count(&room) } else { n };
                    let msg = json!({ "type": "presence", "room": room, "count": n });
                    if socket.send(Message::Text(msg.to_string().into())).await.is_err() {
                        break;
                    }
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
                if let Some((name, st, sig, _)) = islands.get(&ev.nid).cloned() {
                    inflight = Some(tokio::spawn(render(ctx.clone(), ev, name, st, sig)));
                    break;
                }
            }
        }
    }

    if let Some(h) = inflight {
        h.abort();
    }
    for r in &my_rooms {
        hub.room_exit(r);
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
                    let topics = parse_topics(it.get("topics"));
                    islands.insert(nid.to_string(), (name, st, sig, topics));
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
                load: None,
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
        "load": ev.load.as_ref().map(|topic| json!({ "topic": topic })),
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
        if r.status() == reqwest::StatusCode::CONFLICT {
            return Err(RenderError::Stale);
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
        let topics = rv.get("topics").map(|t| parse_topics(Some(t)));
        Ok(RenderOk {
            html,
            state: rv.get("state").cloned(),
            sig: nsig,
            topics,
        })
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
    let RenderOk {
        html,
        state: new_state,
        sig: nsig,
        topics,
    } = match r.result {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[nowaki live] {} re-render {}", r.name, e.reason());
            return send_error(socket, &r.nid, e.reason()).await;
        }
    };
    // Keep the new signature too so the next event can be verified.
    if let Some(ns) = new_state {
        let topics = topics
            .or_else(|| islands.get(&r.nid).map(|e| e.3.clone()))
            .unwrap_or_default();
        islands.insert(r.nid.clone(), (r.name, ns, nsig, topics));
    }
    let Some((_, st, sig, _)) = islands.get(&r.nid) else {
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
            load: None,
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
        assert_eq!(RenderError::Stale.reason(), "stale");
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

    #[test]
    fn topics_are_capped_and_sidecar_lines_need_the_token() {
        let many: Vec<Value> = (0..40).map(|i| json!(format!("t{i}"))).collect();
        assert_eq!(parse_topics(Some(&Value::Array(many))).len(), MAX_TOPICS);
        assert!(parse_topics(Some(&json!(["", "x".repeat(200), "ok"]))).eq(&vec!["ok".to_string()]));

        let hub = LiveHub::new();
        let mut rx = hub.topics.subscribe();
        assert!(!handle_sidecar_line(&hub, "hello"));
        assert!(!handle_sidecar_line(&hub, "NOWAKI_PUBLISH wrong todos"));
        assert!(handle_sidecar_line(
            &hub,
            &format!("NOWAKI_PUBLISH {} todos", publish_token())
        ));
        assert_eq!(rx.try_recv().ok().as_deref(), Some("todos"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_queued_refresh_covers_later_publishes() {
        let mut q = EventQueue::new(4);
        let mut refresh = ev("L0");
        refresh.load = Some("todos".into());
        q.push(refresh).unwrap();
        assert!(q.has_load("L0"));
        assert!(!q.has_load("L1"));
    }

    #[test]
    fn room_presence_counts_sessions_per_room() {
        let hub = LiveHub::new();
        let mut rx = hub.room_presence.subscribe();
        let mut islands = Islands::new();
        islands.insert(
            "L0".into(),
            (
                "Poll".into(),
                json!({ "room": "p" }),
                "s".into(),
                vec!["room:p".into(), "ticks".into()],
            ),
        );
        let (mut a, mut b) = (Default::default(), Default::default());
        sync_rooms(&hub, &mut a, &islands);
        sync_rooms(&hub, &mut b, &islands);
        assert_eq!(hub.room_count("p"), 2);
        assert_eq!(rx.try_recv().unwrap(), ("p".to_string(), 1));
        assert_eq!(rx.try_recv().unwrap(), ("p".to_string(), 2));
        sync_rooms(&hub, &mut b, &Islands::new());
        assert_eq!(hub.room_count("p"), 1);
        assert!(!b.contains("p") && a.contains("p"));
    }
}
