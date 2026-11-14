//! Deploy adapters: turn the build output `dist/` into a deployable artifact for each target.
//!
//! node / bun / deno output runs on `@nowaki-dev/runtime`'s `server/app.mjs` alone, without the
//! nowaki binary. `main.rs` hands `static` to prerender.

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

    /// Command that serves the build, run from inside `dist/server/`.
    fn run_cmd(self) -> &'static str {
        match self {
            Adapter::Bun => "bun index.mjs",
            Adapter::Deno => "deno run -A index.mjs",
            _ => "node index.mjs",
        }
    }
}

/// Writes the server-entry adapters' (node/bun/deno) artifact to `dist/server/`.
pub fn emit_server(root: &Path, dist: &Path, adapter: Adapter) -> Result<()> {
    let server_dir = dist.join("server");
    std::fs::create_dir_all(&server_dir)
        .with_context(|| format!("failed to create dist/server: {}", server_dir.display()))?;

    // runtime::check accepted the installed runtime; without one, the version this CLI needs.
    let runtime_ver = installed_version(root, "@nowaki-dev/runtime")
        .unwrap_or_else(|| crate::runtime::MIN_RUNTIME.into());
    let preact_ver = installed_version(root, "preact").unwrap_or_else(|| "10.25.0".into());
    let prts_ver =
        installed_version(root, "preact-render-to-string").unwrap_or_else(|| "6.5.0".into());

    let index = format!(
        r#"// nowaki deploy entry ({label} adapter, generated).
// `{run}` in this directory serves production. No nowaki binary needed.
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
    let pkg = serde_json::json!({
        "name": "nowaki-app-server",
        "private": true,
        "type": "module",
        "scripts": { "start": adapter.run_cmd() },
        "dependencies": {
            "@nowaki-dev/runtime": format!("^{runtime_ver}"),
            "preact": format!("^{preact_ver}"),
            "preact-render-to-string": format!("^{prts_ver}"),
        },
    });
    let pkg = serde_json::to_string_pretty(&pkg)? + "\n";
    std::fs::write(server_dir.join("package.json"), pkg)?;

    println!(
        "[nowaki] {} adapter: wrote dist/server/index.mjs. Deploy: `cd dist/server && npm install --omit=dev && {}`",
        adapter.label(),
        adapter.run_cmd()
    );
    Ok(())
}

/// Generates `dist/worker/`. The work is done by the runtime's `server/edge-build.mjs`.
pub fn emit_cloudflare(root: &Path, dist: &Path) -> Result<()> {
    let script = crate::runtime::script(root, "edge-build.mjs", "the cloudflare adapter")?;
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

/// Generates `.vercel/output/`. The work is done by the runtime's `server/vercel-build.mjs`.
pub fn emit_vercel(root: &Path, dist: &Path) -> Result<()> {
    let script = crate::runtime::script(root, "vercel-build.mjs", "the vercel adapter")?;
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

/// The version installed in the app's `node_modules` (for the `^x.y.z` range).
fn installed_version(root: &Path, pkg: &str) -> Option<String> {
    read_json_field(
        &root.join("node_modules").join(pkg).join("package.json"),
        "version",
    )
}

/// The top-level string `field` of a package.json, if the file parses and has one.
fn read_json_field(pj: &Path, field: &str) -> Option<String> {
    let text = std::fs::read_to_string(pj).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get(field)?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_package_json_is_json_with_the_installed_versions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A nested "version" before the top-level one: read the top level.
        let rt = root.join("node_modules/@nowaki-dev/runtime");
        std::fs::create_dir_all(&rt).unwrap();
        std::fs::write(
            rt.join("package.json"),
            r#"{"engines":{"version":"x"},"version":"1.2.3-rc.\"1\""}"#,
        )
        .unwrap();
        let dist = root.join("dist");
        emit_server(root, &dist, Adapter::Node).unwrap();
        let text = std::fs::read_to_string(dist.join("server/package.json")).unwrap();
        let pkg: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(
            pkg["dependencies"]["@nowaki-dev/runtime"],
            "^1.2.3-rc.\"1\""
        );
        assert_eq!(pkg["scripts"]["start"], "node index.mjs");

        // No runtime installed: the version this CLI needs.
        std::fs::remove_dir_all(&rt).unwrap();
        emit_server(root, &dist, Adapter::Node).unwrap();
        let text = std::fs::read_to_string(dist.join("server/package.json")).unwrap();
        let pkg: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            pkg["dependencies"]["@nowaki-dev/runtime"],
            format!("^{}", crate::runtime::MIN_RUNTIME)
        );
    }
}
