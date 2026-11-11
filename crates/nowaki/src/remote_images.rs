//! Remote images (`images.remotePatterns`): the [`RemoteFetch`] that downloads through
//! `server/images-fetch.mjs` (the CLI has no TLS stack of its own), and the settings shared by
//! the module pipeline (nowaki-core) and Markdown content entries (content.rs).
//!
//! nowaki-core checks the patterns and the cache first; Node starts only for downloads.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Context, Result};
use nowaki_core::remote_image::{RemoteFetch, RemoteImages, RemotePattern, RemoteRequest};
use serde_json::Value;

struct NodeFetch {
    root: PathBuf,
}

impl NodeFetch {
    fn run(&self, patterns: &[RemotePattern], requests: &[RemoteRequest]) -> Result<Vec<Value>> {
        use std::io::Write;
        let script = self
            .root
            .join("node_modules/@nowaki-dev/runtime/server/images-fetch.mjs");
        if !script.exists() {
            return Err(anyhow!(
                "remote images need @nowaki-dev/runtime 0.18 or newer (server/images-fetch.mjs not found)"
            ));
        }
        let mut child = std::process::Command::new("node")
            .arg(&script)
            .current_dir(&self.root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .context("failed to run node for remote images")?;
        let input = serde_json::json!({ "patterns": patterns, "requests": requests }).to_string();
        child
            .stdin
            .take()
            .expect("piped")
            .write_all(input.as_bytes())?;
        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(anyhow!("images-fetch.mjs failed"));
        }
        serde_json::from_slice(&output.stdout).context("images-fetch.mjs printed invalid JSON")
    }
}

impl RemoteFetch for NodeFetch {
    fn fetch(&self, patterns: &[RemotePattern], requests: &[RemoteRequest]) -> Vec<Result<()>> {
        match self.run(patterns, requests) {
            Ok(list) => (0..requests.len())
                .map(|i| match list.get(i) {
                    Some(v) if v["ok"] == Value::Bool(true) => Ok(()),
                    Some(v) => Err(anyhow!(
                        "{}",
                        v["error"].as_str().unwrap_or("download failed")
                    )),
                    None => Err(anyhow!("images-fetch.mjs returned no result")),
                })
                .collect(),
            Err(e) => {
                let msg = format!("{e:#}");
                requests.iter().map(|_| Err(anyhow!("{msg}"))).collect()
            }
        }
    }
}

static CURRENT: OnceLock<Arc<RemoteImages>> = OnceLock::new();

/// Reads `images.remotePatterns` from the config (`plugins::Spawned::finish`) and gives them, with the Node
/// fetcher, to `core` and to content entries. Without patterns every remote `?image` is refused.
pub fn configure(core: &mut nowaki_core::NowakiCore, root: &Path, config: &Value) -> Result<()> {
    let patterns: Vec<RemotePattern> = match config.pointer("/images/remotePatterns") {
        Some(v) => serde_json::from_value(v.clone())
            .context("nowaki.config: unexpected images.remotePatterns from site-config.mjs")?,
        None => Vec::new(),
    };
    let remote = Arc::new(RemoteImages::new(
        root.to_path_buf(),
        patterns,
        Some(Arc::new(NodeFetch {
            root: root.to_path_buf(),
        })),
    ));
    let _ = CURRENT.set(remote.clone());
    core.set_remote_images(remote);
    Ok(())
}

/// The settings `configure` installed (None before, e.g. in unit tests).
pub fn current() -> Option<Arc<RemoteImages>> {
    CURRENT.get().cloned()
}
