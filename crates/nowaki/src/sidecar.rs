//! The dev SSR sidecar: `server/sidecar.mjs` from the app's `@nowaki-dev/runtime`, run by
//! `nowaki dev` as a Node child on localhost.

use std::path::Path;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The running dev SSR sidecar. Its port comes from the `NOWAKI_SIDECAR_READY` line on stdout.
pub struct Sidecar {
    pub port: u16,
    #[allow(dead_code)] // Held so that dropping the sidecar kills the child.
    child: Child,
}

/// Starts the sidecar and waits for its port. `rust_port` is where the sidecar calls back. Later
/// stdout lines go to the Jetstream hub (`publish()`), the dev error log, or the terminal.
pub async fn spawn(
    root: &Path,
    rust_port: u16,
    live_hub: std::sync::Arc<crate::live::LiveHub>,
    errors: std::sync::Arc<crate::mcp::ErrorLog>,
) -> Result<Sidecar> {
    let entry = root.join("node_modules/@nowaki-dev/runtime/server/sidecar.mjs");
    if !entry.exists() {
        return Err(anyhow!(
            "Dependencies are not installed ({} not found).\n  → Run `npm install` (or pnpm / yarn / bun) in the app directory.",
            entry.display()
        ));
    }

    let mut child = Command::new("node")
        .arg("--enable-source-maps")
        .arg(&entry)
        .current_dir(root)
        .env("NOWAKI_RUST_PORT", rust_port.to_string())
        .env("NOWAKI_PUBLISH_TOKEN", crate::live::publish_token())
        // Exits when this process ends, however it ends: the child watches its stdin pipe
        // (`server/exit-with-parent.mjs`).
        .env("NOWAKI_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("failed to start node")?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let mut port = None;
    while let Some(line) = lines.next_line().await? {
        if let Some(rest) = line.strip_prefix("NOWAKI_SIDECAR_READY ") {
            port = Some(rest.trim().parse::<u16>().context("invalid sidecar port")?);
            break;
        }
        println!("[sidecar] {line}");
    }
    let port = port.ok_or_else(|| anyhow!("sidecar exited without reporting READY"))?;

    // The rest of stdout: `publish()` lines, dev error lines, everything else printed as logs.
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if !crate::live::handle_sidecar_line(&live_hub, &line)
                && !errors.handle_sidecar_line(&line)
            {
                println!("[sidecar] {line}");
            }
        }
    });

    Ok(Sidecar { port, child })
}
