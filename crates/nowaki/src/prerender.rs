use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use nowaki_core::NowakiCore;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Static site generation: build → start a temporary prod server → render each static route to HTML → write out.
pub async fn run(root: PathBuf, out: PathBuf) -> Result<()> {
    let _plugin_host = crate::plugins::start(&root)?;
    let mut core = NowakiCore::new(root.clone());
    if let Some(host) = &_plugin_host {
        core.set_plugins(host.bridge.clone());
    }
    let report = core.build(&root.join("dist"))?;
    println!(
        "[nowaki] build: client {} / server {} modules",
        report.modules, report.server_modules
    );

    let entry = root.join("node_modules/@nowaki-dev/runtime/server/start.mjs");
    if !entry.exists() {
        return Err(anyhow!(
            "@nowaki-dev/runtime not found: {}",
            entry.display()
        ));
    }

    let mut child = Command::new("node")
        .arg("--enable-source-maps")
        .arg(&entry)
        .current_dir(&root)
        .env("PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("failed to start node")?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let mut port = None;
    while let Some(line) = lines.next_line().await? {
        if let Some(rest) = line.strip_prefix("NOWAKI_START_READY ") {
            port = Some(rest.trim().parse::<u16>().context("failed to parse port")?);
            break;
        }
    }
    let port = port.ok_or_else(|| anyhow!("prod server exited without reporting READY"))?;

    let mut pages: Vec<(String, PathBuf)> =
        nowaki_core::routes::enumerate_static_prerender_urls(&root.join("dist/server/routes"))?
            .into_iter()
            .map(|url| {
                let file = out_file_for(&out, &url);
                (url, file)
            })
            .collect();
    for (url, file) in static_paths(&root).await? {
        pages.push((url, out.join(file)));
    }
    if pages.is_empty() {
        return Err(anyhow!("no static routes to prerender"));
    }

    // Don't follow redirects; skip non-200 responses.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    // Output under dist/ (the static adapter) is ours to replace; a user-chosen `--out` is not.
    if out.starts_with(root.join("dist")) {
        nowaki_core::build::clear_dir(&out)?;
    }
    std::fs::create_dir_all(&out)?;
    let mut count = 0;
    for (url_path, file) in &pages {
        let resp = client
            .get(format!("http://127.0.0.1:{port}{url_path}"))
            .send()
            .await?;
        if !resp.status().is_success() {
            eprintln!("[nowaki] {url_path}: skipped ({})", resp.status());
            continue;
        }
        let html = resp.text().await?;
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(file, html)?;
        count += 1;
    }

    // Static hosts (Cloudflare Pages, Netlify, GitHub Pages) serve 404.html for unknown paths.
    // Rendered for /404, since a static page can't know the path that was actually requested.
    if root.join("dist/server/routes/_404.js").exists() {
        let resp = client
            .get(format!("http://127.0.0.1:{port}/404"))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            std::fs::write(out.join("404.html"), resp.text().await?)?;
        }
    }

    // The SPA router fetches this once; a static host has no server to answer it.
    let boundaries = client
        .get(format!("http://127.0.0.1:{port}/__nowaki/boundaries"))
        .send()
        .await?;
    if boundaries.status().is_success() {
        let dir = out.join("__nowaki");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("boundaries"), boundaries.text().await?)?;
    }

    // Only the framework-owned asset dir is cleared; other files in `out` are left alone.
    let assets = out.join("_nowaki");
    nowaki_core::build::clear_dir(&assets)?;
    std::fs::create_dir_all(&assets)?;
    copy_dir(&root.join("dist/client"), &assets)?;
    std::fs::write(
        out.join("_headers"),
        format!(
            "/*\n{}/_nowaki/*\n  Cache-Control: public, max-age=31536000, immutable\n/__nowaki/boundaries\n  Content-Type: application/json\n",
            static_security_headers()
        ),
    )?;

    drop(child);
    println!("[nowaki] prerender done: {count} pages → {}", out.display());
    Ok(())
}

/// Runs the runtime's static-paths.mjs, which evaluates `export const staticPaths` in Node
/// (nowaki-core never runs JS). Returns (request path, file relative to `out`).
async fn static_paths(root: &Path) -> Result<Vec<(String, String)>> {
    let script = root.join("node_modules/@nowaki-dev/runtime/server/static-paths.mjs");
    if !script.exists() {
        return Ok(Vec::new()); // older runtime: dynamic routes stay unrendered, as before
    }
    let output = Command::new("node")
        .arg(&script)
        .arg(root.join("dist/server"))
        .current_dir(root)
        .stderr(Stdio::inherit())
        .output()
        .await
        .context("failed to run static-paths.mjs")?;
    if !output.status.success() {
        return Err(anyhow!("staticPaths failed (see the error above)"));
    }
    let pages: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).context("static-paths.mjs printed invalid JSON")?;
    Ok(pages
        .iter()
        .filter_map(|p| {
            Some((
                p["url"].as_str()?.to_string(),
                p["file"].as_str()?.to_string(),
            ))
        })
        .collect())
}

/// The default security headers as a `_headers` block (Cloudflare Pages / Netlify syntax).
fn static_security_headers() -> String {
    let mut out = String::new();
    for (name, value) in crate::security_headers::DEFAULTS {
        out.push_str(&format!("  {name}: {value}\n"));
    }
    out.push_str(&format!(
        "  content-security-policy: {}\n",
        crate::security_headers::FRAME_CSP
    ));
    out
}

/// URL to output file path. `/` → index.html, `/about` → about/index.html (clean URLs).
fn out_file_for(out: &Path, url: &str) -> PathBuf {
    if url == "/" {
        out.join("index.html")
    } else {
        out.join(format!("{}/index.html", url.trim_start_matches('/')))
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            std::fs::create_dir_all(&dst)?;
            copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}
