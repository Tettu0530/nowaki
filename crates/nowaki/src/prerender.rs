use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use nowaki_core::NowakiCore;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Pages requested from the temporary prod server at once.
const PRERENDER_JOBS: usize = 8;

/// Static site generation: build → start a temporary prod server → render each static route to HTML → write out.
pub async fn run(root: PathBuf, out: PathBuf) -> Result<()> {
    // Checked before building: the build writes dist/, and clearing `out` must never reach it.
    let clear_out = check_out(&root, &out)?;
    let config = crate::site::config(&root)?;
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
    crate::site::write(&root.join("dist"), &config)?;
    crate::fonts::build_dist(&root, &root.join("dist"), &config)?;
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
        // Exits with this process, however it ends (server/exit-with-parent.mjs).
        .env("NOWAKI_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("failed to start node")?;

    let stdout = child.stdout.take().expect("piped stdout");
    let ready = async move {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            if reader.read_until(b'\n', &mut line).await? == 0 {
                return Err(anyhow!("prod server exited without reporting READY"));
            }
            let text = String::from_utf8_lossy(&line);
            if let Some(rest) = text.trim_end().strip_prefix("NOWAKI_START_READY ") {
                let port = rest.trim().parse::<u16>().context("failed to parse port")?;
                return Ok((port, reader));
            }
            print!("{text}"); // the app's own logs
        }
    };
    // Both are Node processes that only read dist/; starting them together hides one Node startup.
    let (ready, dynamic_pages) = tokio::join!(ready, static_paths(&root));
    let (port, mut server_out) = ready?;
    // Keep draining the server's stdout for the whole run: Node writes to a pipe synchronously
    // on Linux, so once app logs fill it (~64 KiB) the renderer would block and every request
    // would hang. (stderr is inherited, so it's never a pipe of ours.)
    let mut drain = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        let mut stdout = tokio::io::stdout();
        let mut forward = true;
        // Read to the end even if our own stdout goes away: the reading is what matters.
        while let Ok(n @ 1..) = server_out.read(&mut buf).await {
            if forward {
                forward = stdout.write_all(&buf[..n]).await.is_ok();
            }
        }
    });

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
    if clear_out {
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
                // A server error is a broken page, not one to leave out: the static deploy would
                // silently miss it. Redirects and 404s are skipped (a guarded or gone page).
                if resp.status().is_server_error() {
                    return Err(anyhow!(
                        "{url_path}: the page failed to render ({})",
                        resp.status()
                    ));
                }
                if !resp.status().is_success() {
                    eprintln!("[nowaki] {url_path}: skipped ({})", resp.status());
                    return Ok::<_, anyhow::Error>(None);
                }
                // Bytes, not text: file routes (og/[card].png.ts) can return binary.
                let bytes = resp.bytes().await?;
                let live = bytes.windows(12).any(|w| w == b"<nowaki-live");
                if let Some(parent) = file.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(file, bytes).await?;
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

    // Generated sitemap.xml / robots.txt (with a site URL), unless a route or public/ wrote one.
    for (url, name) in [
        ("/sitemap.xml", "sitemap.xml"),
        ("/robots.txt", "robots.txt"),
    ] {
        let file = out.join(name);
        if file.exists() || root.join("dist/public").join(name).exists() {
            continue;
        }
        let resp = client
            .get(format!("http://127.0.0.1:{port}{url}"))
            .send()
            .await?;
        if resp.status().is_success() {
            std::fs::write(&file, resp.bytes().await?)?;
            count += 1;
        }
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
    // public/ files at their own path, last, so they win over a page at the same path (as on a
    // server). A `_headers` of the app's own comes first in the generated one.
    let mut own_headers = String::new();
    for (url, src) in nowaki_core::public::list(&root.join("dist/public"))? {
        if url == "/_headers" {
            own_headers = std::fs::read_to_string(&src)?;
            if !own_headers.ends_with('\n') {
                own_headers.push('\n');
            }
            continue;
        }
        let to = out.join(url.trim_start_matches('/'));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&src, &to)?;
    }
    std::fs::write(
        out.join("_headers"),
        format!(
            "{own_headers}/*\n{}/_nowaki/*\n  Cache-Control: public, max-age=31536000, immutable\n/__nowaki/boundaries\n  Content-Type: application/json\n",
            static_security_headers()
        ),
    )?;

    // Closing stdin ends the server (exit-with-parent.mjs); its last logs then reach EOF here.
    // Killed on drop if it doesn't exit in time.
    let grace = std::time::Duration::from_secs(5);
    drop(child.stdin.take());
    let _ = tokio::time::timeout(grace, child.wait()).await;
    if tokio::time::timeout(grace, &mut drain).await.is_err() {
        drain.abort();
    }
    drop(child);
    println!("[nowaki] prerender done: {count} pages → {}", out.display());
    Ok(())
}

/// Refuses an `--out` that is, contains, or sits inside a part of the build it renders from
/// (`dist/`, `dist/client`, `dist/server`, `dist/public`): clearing or writing it would delete the
/// build mid-render. Returns whether `out` is a strict subdirectory of `dist/` of our own (like the
/// default `dist/static`), which is cleared before writing.
fn check_out(root: &Path, out: &Path) -> Result<bool> {
    let dist = normalize(&root.join("dist"));
    let out = normalize(out);
    if dist.starts_with(&out) {
        return Err(anyhow!(
            "--out {} is or contains the build directory {}; prerender reads the build from there. Choose another directory, such as dist/static",
            out.display(),
            dist.display()
        ));
    }
    for part in ["client", "server", "public"] {
        if out.starts_with(dist.join(part)) {
            return Err(anyhow!(
                "--out {} is inside the build ({}); choose another directory, such as dist/static",
                out.display(),
                dist.join(part).display()
            ));
        }
    }
    Ok(out.starts_with(&dist))
}

/// `p` without `.` / `..` segments, resolved through symlinks for the part that exists, so
/// `dist/`, `./dist` and `x/../dist` compare equal.
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut lexical = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            other => lexical.push(other),
        }
    }
    // Canonicalize the longest existing prefix, then re-append the rest.
    let mut rest = Vec::new();
    let mut base = lexical.clone();
    loop {
        if let Ok(real) = dunce::canonicalize(&base) {
            let mut out = real;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (base.file_name().map(|n| n.to_os_string()), base.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent.to_path_buf();
            }
            _ => return lexical,
        }
    }
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
        .stderr(Stdio::piped())
        .output()
        .await
        .context("failed to run static-paths.mjs")?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        eprint!("{stderr}");
        // Name the error itself: Node prints it among the stack lines, easy to miss.
        let cause = stderr
            .lines()
            .map(str::trim)
            .find(|l| {
                l.split_once(':')
                    .is_some_and(|(name, _)| name.ends_with("Error") && !name.contains(' '))
            })
            .unwrap_or("see the output above");
        return Err(anyhow!("staticPaths failed: {cause}"));
    }
    if !stderr.is_empty() {
        eprint!("{stderr}");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_may_not_be_or_contain_the_build() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("dist/server")).unwrap();
        for bad in [
            "dist",
            "dist/",
            "./dist",
            "dist/static/..",
            ".",
            "dist/server",
            "dist/client/x",
            "dist/public",
        ] {
            assert!(check_out(&root, &root.join(bad)).is_err(), "{bad}");
        }
        assert!(check_out(&root, &root.join("..")).is_err());
        assert!(check_out(&root, &root.join("dist/static")).unwrap());
        assert!(check_out(&root, &root.join("./dist/site")).unwrap());
        assert!(!check_out(&root, &root.join("public-site")).unwrap());
        assert!(!check_out(&root, &root.join("distro")).unwrap());
    }
}
