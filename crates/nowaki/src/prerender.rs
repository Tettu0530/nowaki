use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use nowaki_core::NowakiCore;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Pages requested from the temporary prod server at once.
const PRERENDER_JOBS: usize = 8;

/// Static site generation: build → start a temporary prod server → render each static route to HTML → write out.
pub async fn run(root: PathBuf, out: PathBuf) -> Result<()> {
    let _plugin_host = crate::plugins::start(&root)?;
    let mut core = NowakiCore::new(root.clone());
    if let Some(host) = &_plugin_host {
        core.set_plugins(host.bridge.clone());
    }
    let (report, client) = core.build_with_client(&root.join("dist"))?;
    println!(
        "[nowaki] build: client {} / server {} modules",
        report.modules, report.server_modules
    );
    crate::content::build(&root, &root.join("dist"))?;
    crate::check_route_budgets(&core, &report, &client)?;

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
        // Static pages: live islands render their first HTML without live.js (see app.mjs).
        .env("NOWAKI_PRERENDER", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("failed to start node")?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready = async {
        while let Some(line) = lines.next_line().await? {
            if let Some(rest) = line.strip_prefix("NOWAKI_START_READY ") {
                return rest.trim().parse::<u16>().context("failed to parse port");
            }
        }
        Err(anyhow!("prod server exited without reporting READY"))
    };
    // Both are Node processes that only read dist/; starting them together hides one Node startup.
    let (port, dynamic_pages) = tokio::join!(ready, static_paths(&root));
    let port = port?;

    let mut pages: Vec<(String, PathBuf)> =
        nowaki_core::routes::enumerate_static_prerender_urls(&root.join("dist/server/routes"))?
            .into_iter()
            .map(|url| {
                let file = out_file_for(&out, &url);
                (url, file)
            })
            .collect();
    for (url, file) in dynamic_pages? {
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
    // A few requests in flight keep the single-threaded renderer busy while Rust waits on the
    // socket and writes files (2 already saturates a plain app; I/O-bound loaders gain more).
    // `buffered` keeps the original order, so logs and the first error stay deterministic.
    let mut rendered = futures_util::stream::iter(&pages)
        .map(|(url_path, file)| {
            let client = &client;
            async move {
                let resp = client
                    .get(format!("http://127.0.0.1:{port}{url_path}"))
                    .send()
                    .await?;
                if !resp.status().is_success() {
                    eprintln!("[nowaki] {url_path}: skipped ({})", resp.status());
                    return Ok::<_, anyhow::Error>(None);
                }
                let html = resp.text().await?;
                let live = html.contains("<nowaki-live");
                if let Some(parent) = file.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(file, html).await?;
                Ok(Some((url_path.as_str(), live)))
            }
        })
        .buffered(PRERENDER_JOBS);
    let mut count = 0;
    let mut live_pages = Vec::new();
    while let Some(written) = rendered.next().await {
        if let Some((url, live)) = written? {
            count += 1;
            if live {
                live_pages.push(url.to_string());
            }
        }
    }
    drop(rendered);
    if !live_pages.is_empty() {
        eprintln!(
            "[nowaki] note: {} page(s) have live islands, which stay as their first HTML on a static host (no server for their events): {}",
            live_pages.len(),
            live_pages.join(", ")
        );
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
