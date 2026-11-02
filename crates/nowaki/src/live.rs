//! WS session for server-reactive islands (Jetstream). Shared by dev and prod.
//!
//! State lives on the Rust side (this connection) as nid→(name, state); the Node sidecar's
//! `/__nowaki/live-render` is a pure re-evaluation function. The resulting html is pushed as a `patch`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use serde_json::{json, Value};
use tokio::sync::broadcast;

/// Heartbeat interval and idle timeout (disconnect if no pong/message within it).
const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);

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

pub async fn handle(
    mut socket: WebSocket,
    hub: Arc<LiveHub>,
    http: reqwest::Client,
    sidecar_port: u16,
    version: String,
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

    // nid -> (island name, current state, state signature)
    let mut islands: std::collections::HashMap<String, (String, Value, String)> =
        std::collections::HashMap::new();
    let mut last_seen = Instant::now();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await; // discard the immediate first tick

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                last_seen = Instant::now(); // any received message (incl. pong) marks liveness
                if let Message::Text(txt) = msg {
                    if !handle_text(&mut socket, &mut islands, &http, sidecar_port, &version, txt.as_str()).await {
                        break;
                    }
                }
                // Ping/Pong/Binary/Close only update last_seen (Close makes recv return None).
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
    }

    hub.leave();
}

/// Handle a Text message (join/event). true to keep the connection, false to disconnect.
async fn handle_text(
    socket: &mut WebSocket,
    islands: &mut std::collections::HashMap<String, (String, Value, String)>,
    http: &reqwest::Client,
    sidecar_port: u16,
    version: &str,
    txt: &str,
) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(txt) else {
        return true;
    };
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
            true
        }
        Some("event") => {
            let nid = v
                .get("nid")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let Some((name, st, sig)) = islands.get(&nid).cloned() else {
                return true;
            };
            let body = json!({
                "name": name,
                "state": st,
                "sig": sig,
                "handler": v.get("handler"),
                "payload": v.get("payload"),
                "version": version,
            });
            let url = format!("http://127.0.0.1:{sidecar_port}/__nowaki/live-render");
            let resp = http
                .post(&url)
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await;
            let Ok(r) = resp else {
                eprintln!("[nowaki live] sidecar re-render failed");
                return true;
            };
            let Ok(txt) = r.text().await else { return true };
            let Ok(rv) = serde_json::from_str::<Value>(&txt) else {
                return true;
            };
            // No html (the sidecar returned an error, e.g. failed signature check):
            // don't update state or send a patch (never keep forged state / avoid empty renders).
            let Some(html) = rv.get("html").and_then(|h| h.as_str()) else {
                return true;
            };
            // Keep the new signature too so the next event can be verified.
            if let Some(ns) = rv.get("state") {
                let nsig = rv
                    .get("sig")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                islands.insert(nid.clone(), (name, ns.clone(), nsig));
            }
            let patch = json!({ "type": "patch", "nid": nid, "html": html });
            socket
                .send(Message::Text(patch.to_string().into()))
                .await
                .is_ok()
        }
        _ => true,
    }
}
