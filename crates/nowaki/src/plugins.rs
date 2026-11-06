//! Plugin host integration. nowaki-core runs no JS, so hooks are delegated to a Node host over HTTP.
//!
//! Transport is plain HTTP/1.1 over a hand-rolled TcpStream. reqwest::blocking isn't used because it
//! conflicts with the dev tokio runtime.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use nowaki_core::PluginBridge;

/// PluginBridge that delegates `transform` / `.tsrx` / `resolveId` / `load` to the Node plugin host.
struct HttpPluginBridge {
    port: u16,
    has_resolve_id: bool,
    has_load: bool,
}

impl HttpPluginBridge {
    fn call(&self, path: &str, id: &str, code: &str) -> Option<String> {
        let body = serde_json::json!({ "id": id, "code": code }).to_string();
        self.post_field(path, &body, "code")
    }

    fn post_field(&self, path: &str, body: &str, field: &str) -> Option<String> {
        let resp = http_post(self.port, path, body).ok()?;
        let v: serde_json::Value = serde_json::from_str(&resp).ok()?;
        v.get(field).and_then(|c| c.as_str()).map(|s| s.to_string())
    }
}

impl PluginBridge for HttpPluginBridge {
    fn transform(&self, id: &str, code: &str) -> Option<String> {
        self.call("/transform", id, code)
    }
    fn compile_tsrx(&self, id: &str, code: &str) -> Option<String> {
        self.call("/tsrx", id, code)
    }
    fn resolve_id(&self, source: &str, importer: &str) -> Option<String> {
        if !self.has_resolve_id {
            return None;
        }
        let body = serde_json::json!({ "source": source, "importer": importer }).to_string();
        self.post_field("/resolveId", &body, "id")
    }
    fn load(&self, id: &str) -> Option<String> {
        if !self.has_load {
            return None;
        }
        let body = serde_json::json!({ "id": id }).to_string();
        self.post_field("/load", &body, "code")
    }
}

/// A running plugin host. Drop kills the child process.
pub struct PluginHost {
    child: Child,
    pub bridge: Arc<dyn PluginBridge>,
}

impl Drop for PluginHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// None if the config, hooks, or runtime is missing (no host is started, zero overhead).
pub fn start(root: &Path) -> Result<Option<PluginHost>> {
    let has_config = ["nowaki.config.mjs", "nowaki.config.js"]
        .iter()
        .any(|n| root.join(n).exists());
    // If @tsrx/preact is present, start the host for .tsrx even without a config.
    let has_tsrx = root.join("node_modules/@tsrx/preact").is_dir();
    if !has_config && !has_tsrx {
        return Ok(None);
    }
    let script = root.join("node_modules/@nowaki-dev/runtime/server/plugin-host.mjs");
    if !script.exists() {
        eprintln!(
            "[nowaki] nowaki.config found, but @nowaki-dev/runtime is missing, so plugins can't be loaded"
        );
        return Ok(None);
    }

    let mut child = Command::new("node")
        .arg(&script)
        .current_dir(root)
        // Exits with this process, however it ends (server/exit-with-parent.mjs).
        .env("NOWAKI_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("failed to start plugin host (node)")?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let mut port = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if let Some(rest) = line.trim().strip_prefix("NOWAKI_PLUGIN_HOST_READY ") {
            port = Some(rest.parse::<u16>().context("failed to parse port")?);
            break;
        }
    }
    let port = port.ok_or_else(|| anyhow!("plugin host did not report READY"))?;

    // No transform hook and no tsrx means no bridge is needed (kill the host).
    let caps_body = http_get(port, "/caps")?;
    let caps: serde_json::Value = serde_json::from_str(&caps_body).unwrap_or_default();
    let cap = |k: &str| caps.get(k).and_then(|b| b.as_bool()).unwrap_or(false);
    let has_transform = cap("hasTransform");
    let has_tsrx = cap("hasTsrx");
    let has_resolve_id = cap("hasResolveId");
    let has_load = cap("hasLoad");
    if !has_transform && !has_tsrx && !has_resolve_id && !has_load {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(None);
    }

    let bridge: Arc<dyn PluginBridge> = Arc::new(HttpPluginBridge {
        port,
        has_resolve_id,
        has_load,
    });
    let mut feats = Vec::new();
    if has_transform {
        feats.push("transform hook");
    }
    if has_tsrx {
        feats.push(".tsrx (@tsrx/preact)");
    }
    if has_resolve_id || has_load {
        feats.push("virtual modules (resolveId/load)");
    }
    println!("[nowaki] loaded plugins ({})", feats.join(" + "));
    Ok(Some(PluginHost { child, bridge }))
}

// Connection: close, so reading the body to EOF is enough.

fn http_post(port: u16, path: &str, body: &str) -> Result<String> {
    request(port, "POST", path, Some(body))
}

fn http_get(port: u16, path: &str) -> Result<String> {
    request(port, "GET", path, None)
}

fn request(port: u16, method: &str, path: &str, body: Option<&str>) -> Result<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes())?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp)?;
    Ok(resp
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default())
}
