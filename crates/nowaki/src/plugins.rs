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
    fn call(&self, path: &str, id: &str, code: &str) -> Result<Option<String>> {
        let body = serde_json::json!({ "id": id, "code": code }).to_string();
        self.post_field(path, &body, "code")
    }

    /// POSTs to the host and returns `field` (`Ok(None)` when it is null). A host that can't be
    /// reached, answers non-200, or reports `error` is an `Err`: a failure must never read as
    /// "no plugin changed it", or the untransformed source would be served as if it were fine.
    fn post_field(&self, path: &str, body: &str, field: &str) -> Result<Option<String>> {
        let (status, resp) = http_post(self.port, path, body).map_err(|e| {
            anyhow!("plugin host is not responding ({e}); it may have crashed, see the log above")
        })?;
        let v: serde_json::Value = serde_json::from_str(&resp)
            .with_context(|| format!("plugin host sent a bad {path} response (HTTP {status})"))?;
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(anyhow!("{err}"));
        }
        if status != 200 {
            return Err(anyhow!("plugin host answered {path} with HTTP {status}"));
        }
        Ok(v.get(field).and_then(|c| c.as_str()).map(|s| s.to_string()))
    }
}

impl PluginBridge for HttpPluginBridge {
    fn transform(&self, id: &str, code: &str) -> Result<Option<String>> {
        self.call("/transform", id, code)
    }
    fn compile_tsrx(&self, id: &str, code: &str) -> Result<Option<String>> {
        self.call("/tsrx", id, code)
    }
    fn resolve_id(&self, source: &str, importer: &str) -> Option<String> {
        if !self.has_resolve_id {
            return None;
        }
        let body = serde_json::json!({ "source": source, "importer": importer }).to_string();
        // resolve_id has no error channel (a miss ends as "unresolved import"), so say why here.
        match self.post_field("/resolveId", &body, "id") {
            Ok(id) => id,
            Err(e) => {
                eprintln!("[nowaki] plugin resolveId failed for {source:?}: {e:#}");
                None
            }
        }
    }
    fn load(&self, id: &str) -> Result<Option<String>> {
        if !self.has_load {
            return Ok(None);
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
#[cfg(test)]
pub fn start(root: &Path) -> Result<Option<PluginHost>> {
    Ok(spawn(root, false)?.finish()?.0)
}

/// A plugin host that was spawned but not waited for (see [`spawn`]).
pub struct Spawned {
    child: Option<Child>,
    /// The host was asked for site-config.mjs's normalized config too.
    site_config: bool,
}

/// Starts the plugin host without waiting for it, so Node starts and imports nowaki.config while
/// the CLI does other work. With `with_config` the same process also normalizes the build-time
/// config (see crate::site; [`Spawned::finish`] returns it).
pub fn spawn(root: &Path, with_config: bool) -> Result<Spawned> {
    let has_config = ["nowaki.config.mjs", "nowaki.config.js"]
        .iter()
        .any(|n| root.join(n).exists());
    // If @tsrx/preact is present, start the host for .tsrx even without a config.
    let has_tsrx = root.join("node_modules/@tsrx/preact").is_dir();
    let none = || Spawned {
        child: None,
        site_config: false,
    };
    if !has_config && !has_tsrx {
        return Ok(none());
    }
    let script = root.join("node_modules/@nowaki-dev/runtime/server/plugin-host.mjs");
    if !script.exists() {
        eprintln!(
            "[nowaki] nowaki.config found, but @nowaki-dev/runtime is missing, so plugins can't be loaded"
        );
        return Ok(none());
    }
    // Every config is validated (an unknown top-level key throws), not only one that names a
    // build-time key: a typo like `basepath` names none of them.
    let site_config = with_config && has_config;

    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .current_dir(root)
        // Exits with this process, however it ends (server/exit-with-parent.mjs).
        .env("NOWAKI_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if site_config {
        cmd.env("NOWAKI_SITE_CONFIG", "1");
    }
    let child = cmd.spawn().context("failed to start plugin host (node)")?;
    Ok(Spawned {
        child: Some(child),
        site_config,
    })
}

impl Spawned {
    /// Waits for the host. Returns it (None without hooks: the host is killed) and, for
    /// `spawn(_, true)`, the build-time parts of nowaki.config normalized by the runtime
    /// (`{ site?, fonts?, routing?, images? }`; `{}` when the config names none of them, an `Err`
    /// for an invalid config, already explained on stderr).
    pub fn finish(self) -> Result<(Option<PluginHost>, Result<serde_json::Value>)> {
        // No host: no nowaki.config, or no runtime (so no site-config.mjs either).
        let Some(child) = self.child else {
            return Ok((None, Ok(serde_json::Value::Object(Default::default()))));
        };
        self::finish(child, self.site_config)
    }
}

fn finish(
    mut child: Child,
    site_config: bool,
) -> Result<(Option<PluginHost>, Result<serde_json::Value>)> {
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
    let Some(port) = port else {
        let _ = child.wait();
        if site_config {
            // Importing nowaki.config failed (Node printed why).
            return Err(anyhow!("nowaki.config is invalid (see above)"));
        }
        return Err(anyhow!("plugin host did not report READY"));
    };
    // Keep reading the host's stdout for as long as it runs. Dropping the reader here would close
    // the pipe, and the host's next stdout write (a plugin writing to process.stdout) would die
    // with EPIPE, taking every later transform with it.
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut reader, &mut std::io::stderr());
    });

    let (_, caps_body) = http_get(port, "/caps")?;
    let caps: serde_json::Value = serde_json::from_str(&caps_body).unwrap_or_default();
    let config = if !site_config {
        Ok(serde_json::Value::Object(Default::default()))
    } else if let Some(ok) = caps.pointer("/siteConfig/ok") {
        Ok(ok.clone())
    } else if let Some(err) = caps.pointer("/siteConfig/error").and_then(|e| e.as_str()) {
        eprintln!("{err}");
        Err(anyhow!("nowaki.config is invalid (see above)"))
    } else {
        // Every supported runtime (crate::runtime::MIN_RUNTIME) answers it.
        Err(anyhow!(
            "the plugin host did not return nowaki.config (is @nowaki-dev/runtime up to date?)"
        ))
    };

    // No transform hook and no tsrx means no bridge is needed (kill the host).
    let cap = |k: &str| caps.get(k).and_then(|b| b.as_bool()).unwrap_or(false);
    let has_transform = cap("hasTransform");
    let has_tsrx = cap("hasTsrx");
    let has_resolve_id = cap("hasResolveId");
    let has_load = cap("hasLoad");
    if !has_transform && !has_tsrx && !has_resolve_id && !has_load {
        let _ = child.kill();
        let _ = child.wait();
        return Ok((None, config));
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
    Ok((Some(PluginHost { child, bridge }), config))
}

// Connection: close, so reading the body to EOF is enough.

fn http_post(port: u16, path: &str, body: &str) -> Result<(u16, String)> {
    request(port, "POST", path, Some(body))
}

fn http_get(port: u16, path: &str) -> Result<(u16, String)> {
    request(port, "GET", path, None)
}

/// Returns the status code and the body.
fn request(port: u16, method: &str, path: &str, body: Option<&str>) -> Result<(u16, String)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes())?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp)?;
    let (head, body) = resp
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow!("incomplete HTTP response from the plugin host"))?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("bad status line from the plugin host"))?;
    Ok((status, body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp app whose node_modules/@nowaki-dev/runtime points at this repo's runtime package.
    fn app_with_config(config: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/nowaki-runtime");
        let scope = dir.path().join("node_modules/@nowaki-dev");
        std::fs::create_dir_all(&scope).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(runtime.canonicalize().unwrap(), scope.join("runtime")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(runtime.canonicalize().unwrap(), scope.join("runtime"))
            .unwrap();
        std::fs::write(dir.path().join("nowaki.config.mjs"), config).unwrap();
        dir
    }

    #[test]
    fn a_plugin_that_logs_keeps_the_host_alive() {
        // console.log and a raw stdout write in the hook: both used to land on a closed pipe
        // (EPIPE), which killed the host after the first transform.
        let app = app_with_config(
            r#"export default { plugins: [{ name: "loud", transform(code, id) {
                console.log("[loud] transform", id);
                process.stdout.write("raw stdout write\n");
                return code.replaceAll("__MARK__", "done");
            } }] };"#,
        );
        let host = start(app.path())
            .unwrap()
            .expect("plugin host should start");
        for i in 0..5 {
            let out = host
                .bridge
                .transform(&format!("/app/{i}.ts"), "export const x = '__MARK__';")
                .unwrap();
            assert_eq!(out.as_deref(), Some("export const x = 'done';"), "call {i}");
        }
    }

    #[test]
    fn a_throwing_plugin_or_a_dead_host_is_an_error() {
        let app = app_with_config(
            r#"export default { plugins: [{ name: "bad", transform(code) {
                if (code.includes("boom")) throw new Error("plugin exploded");
                return null;
            } }] };"#,
        );
        let mut host = start(app.path())
            .unwrap()
            .expect("plugin host should start");
        assert_eq!(host.bridge.transform("/a.ts", "ok").unwrap(), None);
        let err = host.bridge.transform("/a.ts", "boom").unwrap_err();
        assert!(format!("{err:#}").contains("plugin exploded"), "{err:#}");

        host.child.kill().unwrap();
        host.child.wait().unwrap();
        let err = host.bridge.transform("/a.ts", "ok").unwrap_err();
        assert!(format!("{err:#}").contains("not responding"), "{err:#}");
    }

    #[test]
    fn the_host_reads_the_build_time_config_in_the_same_process() {
        let config = r#"export default {
            site: "https://e.x/",
            basePath: "/app/",
            plugins: [{ name: "p", transform: () => null }],
        };"#;
        let app = app_with_config(config);
        let (host, read) = spawn(app.path(), true).unwrap().finish().unwrap();
        assert!(host.is_some(), "the plugin stays loaded");
        let read = read.unwrap();
        assert_eq!(read["site"], "https://e.x", "normalized");
        assert_eq!(read["routing"]["basePath"], "/app");

        // No plugins: the host goes away, the config is still read.
        let app = app_with_config(r#"export default { site: "https://e.x" };"#);
        let (host, read) = spawn(app.path(), true).unwrap().finish().unwrap();
        assert!(host.is_none());
        assert_eq!(read.unwrap()["site"], "https://e.x");

        // Without the config keys nothing is normalized.
        let app = app_with_config("export default {};");
        let (_, read) = spawn(app.path(), true).unwrap().finish().unwrap();
        assert_eq!(read.unwrap(), serde_json::json!({}));
    }

    #[test]
    fn an_invalid_build_time_config_is_an_error() {
        let app = app_with_config(
            r#"export default { headers: [{ source: "/a", headers: { "x-a": "1\r\n2" } }] };"#,
        );
        let (_, read) = spawn(app.path(), true).unwrap().finish().unwrap();
        let err = read.unwrap_err();
        assert!(
            format!("{err:#}").contains("nowaki.config is invalid"),
            "{err:#}"
        );

        let app = app_with_config("export default { site: ");
        let err = spawn(app.path(), true).unwrap().finish().err().unwrap();
        assert!(
            format!("{err:#}").contains("nowaki.config is invalid"),
            "{err:#}"
        );

        // A config naming no build-time key is still checked: a typo is not silently ignored.
        let app = app_with_config(r#"export default { basepath: "/app" };"#);
        let (_, read) = spawn(app.path(), true).unwrap().finish().unwrap();
        assert!(read.is_err(), "unknown top-level key");
    }
}
