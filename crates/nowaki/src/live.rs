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
        hub.publish(topic);
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

    fn clear(&mut self) {
        self.items.clear();
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

#[derive(Clone)]
struct RenderOk {
    html: String,
    state: Option<Value>,
    sig: String,
    /// Present when the render reported the island's topics (`live.subscribe`).
    topics: Option<Vec<String>>,
    /// The runtime says this render is the same for every connection that asks for it (a room
    /// refresh that read no request context), so it can be shared (see `LiveHub::shared`).
    shareable: bool,
}

/// One publish refresh, rendered once and handed to every connection waiting on the same key,
/// with the signature the renderer's state carried (the sidecar verified it). `None` once rendered
/// means the render wasn't shareable (or failed): each waiter renders its own.
type SharedRender = Arc<tokio::sync::OnceCell<Option<(String, RenderOk)>>>;

struct Rendered {
    nid: String,
    name: String,
    /// The page (see `handle_text`) the render was started for.
    page: u64,
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
    /// Bumped on every `publish(topic)`: refreshes from one publish share a generation.
    topic_gen: std::sync::Mutex<HashMap<String, u64>>,
    /// In-flight and finished refresh renders of the current generation, keyed by
    /// generation + topic + island + version + state (#97).
    shared: std::sync::Mutex<HashMap<String, SharedRender>>,
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
            topic_gen: std::sync::Mutex::new(HashMap::new()),
            shared: std::sync::Mutex::new(HashMap::new()),
        })
    }

    fn publish(&self, topic: &str) {
        let gen = {
            let mut g = self.topic_gen.lock().unwrap();
            let n = g.entry(topic.to_string()).or_default();
            *n += 1;
            *n
        };
        // Entries of older generations of this topic are done; drop them.
        let prefix = format!("{topic}\u{1f}");
        self.shared.lock().unwrap().retain(|k, _| {
            !k.starts_with(&prefix) || k.starts_with(&format!("{prefix}{gen}\u{1f}"))
        });
        let _ = self.topics.send(topic.to_string());
    }

    fn topic_generation(&self, topic: &str) -> u64 {
        self.topic_gen
            .lock()
            .unwrap()
            .get(topic)
            .copied()
            .unwrap_or(0)
    }

    /// The shared slot for one refresh render, created by the first connection that asks.
    fn shared_render(&self, key: String) -> SharedRender {
        self.shared.lock().unwrap().entry(key).or_default().clone()
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

    /// Open connections and (room, connections), sorted by room. For the dev MCP.
    pub fn snapshot(&self) -> (usize, Vec<(String, usize)>) {
        let mut rooms: Vec<_> = self
            .rooms
            .lock()
            .unwrap()
            .iter()
            .map(|(r, n)| (r.clone(), *n))
            .collect();
        rooms.sort();
        (self.count(), rooms)
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
    // Bumped by each replacing join (a client navigation): work queued or in flight for an
    // earlier page is dropped, even where the new page reuses its nids.
    let mut page: u64 = 0;
    let mut queue = EventQueue::new(MAX_QUEUED);
    let mut inflight: Option<tokio::task::JoinHandle<Rendered>> = None;
    let ctx = RenderCtx {
        hub: hub.clone(),
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
                    if let Err(nid) = receive(&mut islands, &mut page, &mut queue, txt.as_str()) {
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
                if !apply_rendered(&mut socket, &mut islands, page, r).await {
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
                    inflight = Some(tokio::spawn(render(ctx.clone(), ev, page, name, st, sig)));
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
    hub: Arc<LiveHub>,
    http: reqwest::Client,
    sidecar_port: u16,
    version: String,
    timeout: Duration,
    request: Arc<Value>,
}

/// Handle a Text message and queue its event. Err(nid) when the queue is full. A replacing join
/// (a new page) empties the queue: the old page's events and refreshes must not reach the new
/// page's island with the same nid.
fn receive(
    islands: &mut Islands,
    page: &mut u64,
    queue: &mut EventQueue,
    txt: &str,
) -> Result<(), String> {
    let was = *page;
    let ev = handle_text(islands, page, txt);
    if *page != was {
        queue.clear();
    }
    ev.map_or(Ok(()), |ev| queue.push(ev))
}

/// Handle a Text message: `join` registers islands; `event` returns the event to queue.
/// A replacing join (a new page) bumps `page`; the caller then drops the queued events.
fn handle_text(islands: &mut Islands, page: &mut u64, txt: &str) -> Option<PendingEvent> {
    let v = serde_json::from_str::<Value>(txt).ok()?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("join") => {
            // `replace`: the client lists every island on its page (after a client navigation
            // too), so the previous page's islands, topics and rooms go.
            if v.get("replace").and_then(|r| r.as_bool()) == Some(true) {
                islands.clear();
                *page += 1;
            }
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
    page: u64,
    name: String,
    st: Value,
    sig: String,
) -> Rendered {
    // A publish refresh (no handler) may be shared: the first connection renders, the others
    // with the same island and state wait for that result instead of asking Node again (#97).
    if let (Some(topic), true) = (ev.load.clone(), ev.handler.is_null()) {
        let key = format!(
            "{topic}\u{1f}{}\u{1f}{name}\u{1f}{}\u{1f}{st}",
            ctx.hub.topic_generation(&topic),
            ctx.version
        );
        let slot = ctx.hub.shared_render(key);
        let mut mine = None;
        let shared = slot
            .get_or_init(|| async {
                let r = render_once(&ctx, &ev, &name, &st, &sig).await;
                let share = r.as_ref().ok().filter(|ok| ok.shareable).cloned();
                mine = Some(r);
                share.map(|ok| (sig.clone(), ok))
            })
            .await
            .clone();
        let result = match (mine, shared) {
            (Some(r), _) => r, // this connection rendered it
            // Another one did, and it is shareable. The key has no signature in it, so this
            // connection's own one still has to be genuine before it gets the HTML and a fresh sig.
            (None, Some((verified, ok))) => verify_own_sig(&ctx, &name, &st, &sig, &verified)
                .await
                .map(|()| ok),
            (None, None) => render_once(&ctx, &ev, &name, &st, &sig).await,
        };
        return Rendered {
            nid: ev.nid,
            name,
            page,
            result,
        };
    }
    let result = render_once(&ctx, &ev, &name, &st, &sig).await;
    Rendered {
        nid: ev.nid,
        name,
        page,
        result,
    }
}

/// Whether a connection waiting on a shared refresh holds a genuine signature for its state. The
/// same signature string the renderer had is already verified (it binds name and state, which the
/// key matched), so steady-state refreshes cost nothing; any other one is checked by the sidecar
/// without rendering.
async fn verify_own_sig(
    ctx: &RenderCtx,
    name: &str,
    st: &Value,
    sig: &str,
    verified: &str,
) -> Result<(), RenderError> {
    if sig == verified {
        return Ok(());
    }
    let body = json!({ "verifyOnly": true, "name": name, "state": st, "sig": sig });
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
        let rv: Value = serde_json::from_str(&r.text().await.map_err(|_| RenderError::Failed)?)
            .map_err(|_| RenderError::Failed)?;
        sig_status(&rv)
    };
    match tokio::time::timeout(ctx.timeout, call).await {
        Ok(r) => r,
        Err(_) => Err(RenderError::Timeout),
    }
}

/// The sidecar's `verifyOnly` answer: only "ok" passes; "expired" reloads the page like a render would.
fn sig_status(rv: &Value) -> Result<(), RenderError> {
    match rv.get("verified").and_then(|v| v.as_str()) {
        Some("ok") => Ok(()),
        Some("expired") => Err(RenderError::Stale),
        _ => Err(RenderError::Failed),
    }
}

async fn render_once(
    ctx: &RenderCtx,
    ev: &PendingEvent,
    name: &str,
    st: &Value,
    sig: &str,
) -> Result<RenderOk, RenderError> {
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
            shareable: rv.get("shareable").and_then(|v| v.as_bool()) == Some(true),
        })
    };
    match tokio::time::timeout(ctx.timeout, call).await {
        Ok(r) => r,
        Err(_) => Err(RenderError::Timeout),
    }
}

/// Store the new state and push the patch, or tell the client the event failed.
/// false when the socket is gone.
async fn apply_rendered(
    socket: &mut WebSocket,
    islands: &mut Islands,
    page: u64,
    r: Rendered,
) -> bool {
    // The page navigated away while this rendered: the island is gone (or its nid is now another
    // page's island), so the result or error is dropped rather than brought back.
    if !still_joined(islands, page, &r) {
        return true;
    }
    let RenderOk {
        html,
        state: new_state,
        sig: nsig,
        topics,
        ..
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

/// Whether the island a render was for is still on the client's page. A client navigation sends a
/// replacing join, which drops the previous page's islands while their renders may be in flight;
/// the new page may reuse the nid (and island name), so the page counter decides.
fn still_joined(islands: &Islands, page: u64, r: &Rendered) -> bool {
    r.page == page && islands.get(&r.nid).is_some_and(|e| e.0 == r.name)
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
        let mut page = 0;
        let join = r#"{"type":"join","islands":[{"nid":"L0","name":"LiveCounter","state":{"count":1},"sig":"s"},{"nid":"","name":"x"}]}"#;
        assert!(handle_text(&mut islands, &mut page, join).is_none());
        assert_eq!(islands.len(), 1);
        assert_eq!(islands["L0"].1, json!({"count": 1}));

        let e = handle_text(
            &mut islands,
            &mut page,
            r#"{"type":"event","nid":"L0","handler":"inc"}"#,
        )
        .unwrap();
        assert_eq!(e.nid, "L0");
        assert_eq!(e.handler, json!("inc"));
        assert!(handle_text(
            &mut islands,
            &mut page,
            r#"{"type":"event","nid":"L9","handler":"inc"}"#
        )
        .is_none());
        assert!(handle_text(&mut islands, &mut page, "not json").is_none());
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
    fn a_publish_starts_a_new_generation_and_drops_older_shared_renders() {
        let hub = LiveHub::new();
        assert_eq!(hub.topic_generation("ticks"), 0);
        hub.publish("ticks");
        let g1 = hub.topic_generation("ticks");
        let a = hub.shared_render(format!("ticks\u{1f}{g1}\u{1f}LiveTicks\u{1f}v\u{1f}{{}}"));
        let b = hub.shared_render(format!("ticks\u{1f}{g1}\u{1f}LiveTicks\u{1f}v\u{1f}{{}}"));
        assert!(Arc::ptr_eq(&a, &b), "the same refresh shares one slot");
        let other = hub.shared_render("poll\u{1f}0\u{1f}LivePoll\u{1f}v\u{1f}{}".to_string());
        hub.publish("ticks");
        assert_eq!(hub.topic_generation("ticks"), g1 + 1);
        let keys: Vec<String> = hub.shared.lock().unwrap().keys().cloned().collect();
        assert!(
            !keys.iter().any(|k| k.starts_with("ticks\u{1f}")),
            "older ticks renders are dropped: {keys:?}"
        );
        assert_eq!(keys.len(), 1, "other topics are kept");
        drop(other);
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

    /// A stand-in sidecar: signatures starting with "good" are genuine, "old" is expired, anything
    /// else is forged. Counts full renders and verify-only calls.
    async fn fake_sidecar() -> (u16, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let renders = Arc::new(AtomicUsize::new(0));
        let verifies = Arc::new(AtomicUsize::new(0));
        let (r, v) = (renders.clone(), verifies.clone());
        let app = axum::Router::new().route(
            "/__nowaki/live-render",
            axum::routing::post(move |body: String| {
                let (r, v) = (r.clone(), v.clone());
                async move {
                    let b: Value = serde_json::from_str(&body).unwrap();
                    let sig = b["sig"].as_str().unwrap_or("");
                    let status = if sig.starts_with("good") {
                        "ok"
                    } else if sig == "old" {
                        "expired"
                    } else {
                        "invalid"
                    };
                    if b["verifyOnly"] == json!(true) {
                        v.fetch_add(1, Ordering::SeqCst);
                        return (
                            axum::http::StatusCode::OK,
                            json!({ "verified": status }).to_string(),
                        );
                    }
                    r.fetch_add(1, Ordering::SeqCst);
                    match status {
                        "ok" => (
                            axum::http::StatusCode::OK,
                            json!({ "html": "<p>room data</p>", "state": b["state"], "sig": "good-fresh", "shareable": true }).to_string(),
                        ),
                        "expired" => (axum::http::StatusCode::CONFLICT, "{}".into()),
                        _ => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "{}".into()),
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (port, renders, verifies)
    }

    #[tokio::test]
    async fn a_shared_refresh_goes_only_to_connections_with_a_genuine_signature() {
        let (port, renders, verifies) = fake_sidecar().await;
        let hub = LiveHub::new();
        hub.publish("room:r-secret");
        let ctx = RenderCtx {
            hub,
            http: reqwest::Client::new(),
            sidecar_port: port,
            version: "v".into(),
            timeout: Duration::from_secs(5),
            request: Arc::new(json!({ "headers": {} })),
        };
        let st = json!({ "room": "r-secret" });
        let refresh = |nid: &str| PendingEvent {
            nid: nid.into(),
            handler: Value::Null,
            payload: Value::Null,
            load: Some("room:r-secret".into()),
        };
        let go = |nid: &str, sig: &str| {
            render(
                ctx.clone(),
                refresh(nid),
                "Room".into(),
                st.clone(),
                sig.into(),
            )
        };

        let first = go("A", "good-1").await.result.expect("the renderer");
        assert_eq!(first.html, "<p>room data</p>");
        assert_eq!(renders.load(Ordering::SeqCst), 1);

        assert_eq!(
            go("B", "v1.0.forged").await.result.err(),
            Some(RenderError::Failed),
            "a forged signature gets neither the room's HTML nor a fresh signature"
        );
        assert_eq!(
            go("C", "old").await.result.err(),
            Some(RenderError::Stale),
            "an expired signature reloads instead of being refreshed"
        );

        let same = go("D", "good-1")
            .await
            .result
            .expect("same signature as the renderer");
        assert_eq!(same.sig, "good-fresh");
        assert_eq!(
            verifies.load(Ordering::SeqCst),
            2,
            "the renderer's own sig needs no check"
        );
        let other = go("E", "good-2")
            .await
            .result
            .expect("another genuine signature");
        assert_eq!(other.html, "<p>room data</p>");
        assert_eq!(verifies.load(Ordering::SeqCst), 3);
        assert_eq!(
            renders.load(Ordering::SeqCst),
            1,
            "still one render per publish"
        );
    }

    #[test]
    fn a_replacing_join_drops_the_previous_pages_islands() {
        let hub = LiveHub::new();
        let mut rooms = Default::default();
        let mut islands = Islands::new();
        let mut page = 0;
        let page1 = r#"{"type":"join","islands":[{"nid":"L0","name":"Poll","state":{"room":"p"},"sig":"s","topics":["room:p"]}]}"#;
        handle_text(&mut islands, &mut page, page1);
        sync_rooms(&hub, &mut rooms, &islands);
        assert_eq!(hub.room_count("p"), 1);

        // A join without `replace` (a POST handing over new state) adds to what's there.
        let more =
            r#"{"type":"join","islands":[{"nid":"L1","name":"LiveCounter","state":{},"sig":"s"}]}"#;
        handle_text(&mut islands, &mut page, more);
        assert_eq!(islands.len(), 2);
        assert_eq!(page, 0);

        // A client navigation: the new page's islands replace the old ones, and their rooms go.
        let page2 = r#"{"type":"join","replace":true,"islands":[{"nid":"L0","name":"LiveCounter","state":{"count":0},"sig":"s"}]}"#;
        handle_text(&mut islands, &mut page, page2);
        sync_rooms(&hub, &mut rooms, &islands);
        assert_eq!(page, 1);
        assert_eq!(islands.len(), 1);
        assert_eq!(islands["L0"].0, "LiveCounter");
        assert_eq!(hub.room_count("p"), 0);
        assert!(handle_text(
            &mut islands,
            &mut page,
            r#"{"type":"event","nid":"L1","handler":"inc"}"#
        )
        .is_none());

        // A render started for the old page is not applied: L0 is another island now, L1 is
        // gone, and a reused nid and name (the same page revisited) is still the old page's.
        let done = |nid: &str, name: &str, page: u64| Rendered {
            nid: nid.into(),
            name: name.into(),
            page,
            result: Err(RenderError::Stale),
        };
        assert!(!still_joined(&islands, page, &done("L0", "Poll", 0)));
        assert!(!still_joined(&islands, page, &done("L1", "LiveCounter", 0)));
        assert!(!still_joined(&islands, page, &done("L0", "LiveCounter", 0)));
        assert!(still_joined(&islands, page, &done("L0", "LiveCounter", 1)));
    }

    #[test]
    fn a_replacing_join_drops_the_old_pages_queued_events() {
        let mut islands = Islands::new();
        let mut page = 0;
        let mut q = EventQueue::new(MAX_QUEUED);
        let join = |replace: bool| {
            format!(
                r#"{{"type":"join","replace":{replace},"islands":[{{"nid":"L0","name":"LiveCounter","state":{{"count":0}},"sig":"s"}}]}}"#
            )
        };
        let event = r#"{"type":"event","nid":"L0","handler":"inc"}"#;
        receive(&mut islands, &mut page, &mut q, &join(true)).unwrap();
        receive(&mut islands, &mut page, &mut q, event).unwrap();
        receive(&mut islands, &mut page, &mut q, event).unwrap();
        // A join that only hands over state keeps the queue.
        receive(&mut islands, &mut page, &mut q, &join(false)).unwrap();
        assert_eq!(q.items.len(), 2);

        // The same page again (same nid and island): the old page's events go, the new one's stay.
        receive(&mut islands, &mut page, &mut q, &join(true)).unwrap();
        assert!(q.pop().is_none());
        receive(&mut islands, &mut page, &mut q, event).unwrap();
        assert_eq!(q.pop().map(|e| e.nid), Some("L0".into()));
    }
}
