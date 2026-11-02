//! Deploy adapters. Turn the build output `dist/` into a deployable artifact for each target.
//!
//! node/bun/deno output runs on `@nowaki-dev/runtime`'s app.mjs alone; no nowaki binary needed.
//! `static` is delegated to prerender in main.

use std::path::Path;

use anyhow::{Context, Result};
use clap::ValueEnum;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum Adapter {
    /// Self-contained Node server (default)
    #[default]
    Node,
    /// Static site (SSG, prerender)
    Static,
    /// Bun runtime (same node:http-compatible entry)
    Bun,
    /// Deno runtime (same node:http-compatible entry)
    Deno,
    /// Cloudflare Workers (Edge, fetch handler + static assets binding)
    Cloudflare,
    /// Vercel (Build Output API v3, Node serverless function + static assets)
    Vercel,
}

impl Adapter {
    fn label(self) -> &'static str {
        match self {
            Adapter::Node => "node",
            Adapter::Static => "static",
            Adapter::Bun => "bun",
            Adapter::Deno => "deno",
            Adapter::Cloudflare => "cloudflare",
            Adapter::Vercel => "vercel",
        }
    }

    fn run_cmd(self) -> &'static str {
        match self {
            Adapter::Bun => "bun dist/server/index.mjs",
            Adapter::Deno => "deno run -A dist/server/index.mjs",
            _ => "node dist/server/index.mjs",
        }
    }
}

/// Write the server-entry adapters' (node/bun/deno) artifact to `dist/server/`.
pub fn emit_server(root: &Path, dist: &Path, adapter: Adapter) -> Result<()> {
    let server_dir = dist.join("server");
    std::fs::create_dir_all(&server_dir)
        .with_context(|| format!("failed to create dist/server: {}", server_dir.display()))?;

    let runtime_ver =
        installed_version(root, "@nowaki-dev/runtime").unwrap_or_else(|| "0.6.0".into());
    let preact_ver = installed_version(root, "preact").unwrap_or_else(|| "10.25.0".into());
    let prts_ver =
        installed_version(root, "preact-render-to-string").unwrap_or_else(|| "6.5.0".into());

    let index = format!(
        r#"// nowaki deploy entry ({label} adapter, generated).
// `{run}` alone serves production. No nowaki binary needed.
// Deps: @nowaki-dev/runtime / preact / preact-render-to-string (package.json in this dir).
import path from "node:path";
import {{ fileURLToPath }} from "node:url";
import {{ startServer }} from "@nowaki-dev/runtime/server/app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/server
await startServer({{
  clientDir: path.join(here, "../client"),
  serverDir: here,
  port: Number(process.env.PORT ?? 3000),
}});
"#,
        label = adapter.label(),
        run = adapter.run_cmd(),
    );
    std::fs::write(server_dir.join("index.mjs"), index)?;

    // Minimal package.json for `npm install` at deploy time (runtime deps only).
    let pkg = format!(
        r#"{{
  "name": "nowaki-app-server",
  "private": true,
  "type": "module",
  "scripts": {{
    "start": "node index.mjs"
  }},
  "dependencies": {{
    "@nowaki-dev/runtime": "^{runtime_ver}",
    "preact": "^{preact_ver}",
    "preact-render-to-string": "^{prts_ver}"
  }}
}}
"#,
    );
    std::fs::write(server_dir.join("package.json"), pkg)?;

    println!(
        "[nowaki] {} adapter: wrote dist/server/index.mjs. Deploy: `cd dist/server && npm install --omit=dev && {}`",
        adapter.label(),
        adapter.run_cmd()
    );
    Ok(())
}

/// Generate `dist/worker/`. The work is done by the runtime's `server/edge-build.mjs`.
pub fn emit_cloudflare(root: &Path, dist: &Path) -> Result<()> {
    let script = root.join("node_modules/@nowaki-dev/runtime/server/edge-build.mjs");
    if !script.exists() {
        anyhow::bail!("@nowaki-dev/runtime not found: {}", script.display());
    }
    let app_name = read_json_field(&root.join("package.json"), "name")
        .map(|n| sanitize_worker_name(&n))
        .unwrap_or_else(|| "nowaki-app".into());
    let status = std::process::Command::new("node")
        .arg(&script)
        .arg(dist.join("server"))
        .arg(dist.join("client"))
        .arg(dist.join("worker"))
        .arg(&app_name)
        .current_dir(root)
        .status()
        .context("failed to start node edge-build.mjs")?;
    if !status.success() {
        anyhow::bail!("cloudflare adapter generation failed");
    }
    println!(
        "[nowaki] cloudflare adapter: wrote dist/worker. Test: `cd dist/worker && npx wrangler dev` / Deploy: `cd dist/worker && npx wrangler deploy`"
    );
    Ok(())
}

/// Generate `.vercel/output/`. The work is done by the runtime's `server/vercel-build.mjs`.
pub fn emit_vercel(root: &Path, dist: &Path) -> Result<()> {
    let script = root.join("node_modules/@nowaki-dev/runtime/server/vercel-build.mjs");
    if !script.exists() {
        anyhow::bail!("@nowaki-dev/runtime not found: {}", script.display());
    }
    let output = root.join(".vercel/output");
    let status = std::process::Command::new("node")
        .arg(&script)
        .arg(dist.join("server"))
        .arg(dist.join("client"))
        .arg(&output)
        .arg(root)
        .current_dir(root)
        .status()
        .context("failed to start node vercel-build.mjs")?;
    if !status.success() {
        anyhow::bail!("vercel adapter generation failed");
    }
    println!(
        "[nowaki] vercel adapter: wrote .vercel/output. Deploy: `npx vercel deploy --prebuilt` (or `vercel --prebuilt`)"
    );
    Ok(())
}

/// Worker names allow only lowercase alphanumerics and hyphens.
fn sanitize_worker_name(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "nowaki-app".into()
    } else {
        trimmed
    }
}

/// Read the actually installed version from the app's node_modules (for the `^x.y.z` pin).
fn installed_version(root: &Path, pkg: &str) -> Option<String> {
    read_json_field(
        &root.join("node_modules").join(pkg).join("package.json"),
        "version",
    )
}

/// Naively pick `"<field>": "..."` out of package.json (avoids adding serde).
fn read_json_field(pj: &Path, field: &str) -> Option<String> {
    let text = std::fs::read_to_string(pj).ok()?;
    let key = format!("\"{field}\"");
    let i = text.find(&key)?;
    let after = &text[i + key.len()..];
    let start = after.find('"')? + 1;
    let rest = &after[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}
