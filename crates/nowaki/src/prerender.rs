use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use nowaki_core::rules::TrailingSlash;
use nowaki_core::NowakiCore;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Pages requested from the temporary prod server at once.
const PRERENDER_JOBS: usize = 8;

/// Static site generation: build → start a temporary prod server → render each static route to HTML → write out.
pub async fn run(root: PathBuf, out: PathBuf) -> Result<()> {
    // Checked before building: the build writes dist/, and clearing `out` must never reach it.
    let clear_out = check_out(&root, &out)?;
    let env_check = crate::env_schema::start(&root)?;
    let config = crate::site::config(&root)?;
    let _plugin_host = crate::plugins::start(&root)?;
    let mut core = NowakiCore::new(root.clone());
    if let Some(host) = &_plugin_host {
        core.set_plugins(host.bridge.clone());
    }
    // env.ts: validated before the build, which inlines its public values.
    crate::env_schema::finish(env_check, &mut core)?;
    crate::remote_images::configure(&mut core, &root, &config)?;
    let (report, client) = core.build_with_client(&root.join("dist"))?;
    println!(
        "[nowaki] build: client {} / server {} modules",
        report.modules, report.server_modules
    );
    crate::content::build(&root, &root.join("dist"))?;
    crate::site::write(&root.join("dist"), &config)?;
    crate::fonts::build_dist(&root, &root.join("dist"), &config)?;
    crate::check_route_budgets(&core, &report, &client)?;
    let routing_file = root.join("dist/server/routing.json");
    let routing: nowaki_core::rules::RoutingConfig = match std::fs::read_to_string(&routing_file) {
        Ok(text) => serde_json::from_str(&text)?,
        Err(_) => nowaki_core::rules::RoutingConfig::default(),
    };
    let trailing = routing.trailing_slash;
    // The temporary server applies nowaki.config routing, so pages are requested by the URL a
    // browser uses (basePath, trailing slash).
    let front = crate::front::load(&routing_file)?;
    let request_path = |url: &str| match &front {
        Some(f) => f.browser_path(url),
        None => url.to_string(),
    };

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
                let file = out_file_for(&out, &url, trailing);
                (url, file)
            })
            .collect();
    for (url, file, page) in dynamic_pages? {
        let file = if page {
            page_file(&file, trailing)
        } else {
            file
        };
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
            let request = request_path(url_path);
            async move {
                let resp = client
                    .get(format!("http://127.0.0.1:{port}{request}"))
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
            .get(format!("http://127.0.0.1:{port}{}", request_path(url)))
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
            .get(format!("http://127.0.0.1:{port}{}", request_path("/404")))
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
    let mut own_redirects = String::new();
    for (url, src) in nowaki_core::public::list(&root.join("dist/public"))? {
        if url == "/_headers" || url == "/_redirects" {
            let mut text = std::fs::read_to_string(&src)?;
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            if url == "/_headers" {
                own_headers = text;
            } else {
                own_redirects = text;
            }
            continue;
        }
        let to = out.join(url.trim_start_matches('/'));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&src, &to)?;
    }
    // nowaki.config routing for static hosts (Cloudflare Pages / Netlify syntax): redirects and
    // rewrites in `_redirects` after the app's own, config headers at the end of `_headers`.
    let rendered_urls: Vec<&str> = pages.iter().map(|(u, _)| u.as_str()).collect();
    let host = static_host_rules(&routing, &rendered_urls);
    for w in &host.warnings {
        eprintln!("[nowaki] static output: {w}");
    }
    if !own_redirects.is_empty() || !host.redirects.is_empty() {
        std::fs::write(
            out.join("_redirects"),
            format!("{own_redirects}{}", host.redirects),
        )?;
    }
    std::fs::write(
        out.join("_headers"),
        format!(
            "{own_headers}/*\n{}/_nowaki/*\n  Cache-Control: public, max-age=31536000, immutable\n/__nowaki/boundaries\n  Content-Type: application/json\n{}",
            static_security_headers(),
            host.headers
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
/// (nowaki-core never runs JS). Returns (request path, file relative to `out`, whether it's a
/// page rather than a file route).
async fn static_paths(root: &Path) -> Result<Vec<(String, String, bool)>> {
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
                p["kind"].as_str() != Some("file"),
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

/// URL to output file path, laid out the way static hosts map files to URLs: `/` → index.html;
/// `/about` → about/index.html (served at `/about/`), or about.html under `trailingSlash: "never"`
/// (served at `/about`).
fn out_file_for(out: &Path, url: &str, trailing: TrailingSlash) -> PathBuf {
    if url == "/" {
        out.join("index.html")
    } else {
        out.join(page_file(
            &format!("{}/index.html", url.trim_start_matches('/')),
            trailing,
        ))
    }
}

/// A page's `x/index.html` as `x.html` under `trailingSlash: "never"`; unchanged otherwise.
fn page_file(file: &str, trailing: TrailingSlash) -> String {
    match file.strip_suffix("/index.html") {
        Some(dir) if trailing == TrailingSlash::Never && !dir.is_empty() => {
            format!("{dir}.html")
        }
        _ => file.to_string(),
    }
}

/// nowaki.config routing in static-host form, with what a host can't do.
#[derive(Default)]
struct StaticHostRules {
    redirects: String,
    headers: String,
    warnings: Vec<String>,
}

/// `_redirects` / `_headers` (Cloudflare Pages / Netlify) from the routing config: `[x]` becomes
/// `:x`, `[...x]` becomes `*` in a source and `:splat` in a destination, rewrites are 200 rules.
/// Rules a static host can't express are left out with a warning. `rendered` lists the prerendered
/// page URLs (a rewrite can only reach a page that exists as a file).
fn static_host_rules(
    config: &nowaki_core::rules::RoutingConfig,
    rendered: &[&str],
) -> StaticHostRules {
    let mut out = StaticHostRules::default();
    let base = config.base_path.as_str();
    if !base.is_empty() {
        out.warnings.push(format!(
            "basePath {base:?}: pages are written at the root of the output; deploy them under {base} (the rules below include it)"
        ));
    }
    let internal = |d: &str| {
        if d.starts_with('/') {
            if d == "/" && !base.is_empty() {
                base.to_string()
            } else {
                format!("{base}{d}")
            }
        } else {
            d.to_string()
        }
    };
    for r in &config.redirects {
        match (static_pattern(&r.source, true), static_pattern(&r.destination, false)) {
            (Some(from), Some(to)) => out.redirects.push_str(&format!(
                "{} {} {}\n",
                internal(&from),
                internal(&to),
                r.status
            )),
            _ => out.warnings.push(format!(
                "redirect {} → {} can't be written for a static host (a [x].ext segment or a param name other than letters, digits and _); left out",
                r.source, r.destination
            )),
        }
    }
    for r in &config.rewrites {
        let (Some(from), Some(to)) = (
            static_pattern(&r.source, true),
            static_pattern(&r.destination, false),
        ) else {
            out.warnings.push(format!(
                "rewrite {} → {} can't be written for a static host; left out",
                r.source, r.destination
            ));
            continue;
        };
        if !rendered
            .iter()
            .any(|u| route_could_match(&r.destination, u))
        {
            out.warnings.push(format!(
                "rewrite {} → {}: no prerendered page matches the destination, so a static host has nothing to serve",
                r.source, r.destination
            ));
        }
        out.redirects
            .push_str(&format!("{} {} 200\n", internal(&from), internal(&to)));
    }
    let defaults: Vec<&str> = crate::security_headers::DEFAULTS
        .iter()
        .map(|(n, _)| *n)
        .chain(["content-security-policy"])
        .collect();
    for h in &config.headers {
        let Some(from) = static_pattern(&h.source, true) else {
            out.warnings.push(format!(
                "headers for {} can't be written for a static host; left out",
                h.source
            ));
            continue;
        };
        out.headers.push_str(&internal(&from));
        out.headers.push('\n');
        for header in &h.headers {
            let name = header.key.to_ascii_lowercase();
            if defaults.contains(&name.as_str()) {
                out.warnings.push(format!(
                    "headers for {}: a static host may combine {name} with the default value instead of replacing it",
                    h.source
                ));
            }
            out.headers
                .push_str(&format!("  {}: {}\n", header.key, header.value));
        }
    }
    out
}

/// A rule path in `_redirects` syntax, or `None` when it has no equivalent there.
fn static_pattern(path: &str, source: bool) -> Option<String> {
    let (origin, rest) = match path.find("://") {
        Some(i) => {
            let after = &path[i + 3..];
            let end = i + 3 + after.find('/').unwrap_or(after.len());
            (&path[..end], &path[end..])
        }
        None => ("", path),
    };
    let named = |n: &str| {
        !n.is_empty()
            && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && !n.as_bytes()[0].is_ascii_digit()
    };
    let mut out = String::from(origin);
    for seg in rest.split('/').skip(1) {
        out.push('/');
        if let Some(name) = seg.strip_prefix("[...").and_then(|s| s.strip_suffix(']')) {
            if !named(name) {
                return None;
            }
            out.push_str(if source { "*" } else { ":splat" });
        } else if let Some(name) = seg.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if !named(name) || name == "splat" {
                return None;
            }
            out.push(':');
            out.push_str(name);
        } else if seg.contains(['[', ']']) {
            return None;
        } else {
            out.push_str(seg);
        }
    }
    if out.is_empty() {
        out.push('/');
    }
    Some(out)
}

/// Whether a route pattern (`/photo/[id]`) could match the page URL `url`.
fn route_could_match(pattern: &str, url: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let parts: Vec<&str> = url.split('/').filter(|s| !s.is_empty()).collect();
    let rest = pat.last().is_some_and(|s| s.starts_with("[..."));
    if (rest && parts.len() < pat.len()) || (!rest && parts.len() != pat.len()) {
        return false;
    }
    pat.iter()
        .zip(&parts)
        .all(|(p, u)| p.starts_with('[') || p == u)
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

    fn routing(json: &str) -> nowaki_core::rules::RoutingConfig {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn static_host_files_from_the_routing_config() {
        let host = static_host_rules(
            &routing(
                r#"{
                "redirects":[
                    {"source":"/old/[...rest]","destination":"/new/[...rest]","status":308},
                    {"source":"/blog/[slug]","destination":"https://example.com/b/[slug]","status":301},
                    {"source":"/og/[card].png","destination":"/cards/[card].png","status":302}
                ],
                "rewrites":[
                    {"source":"/p/[id]","destination":"/photo/[id]"},
                    {"source":"/x","destination":"/nowhere"}
                ],
                "headers":[{"source":"/api/[...rest]","headers":[
                    {"key":"Cache-Control","value":"no-store"},
                    {"key":"X-Frame-Options","value":"DENY"}
                ]}]
            }"#,
            ),
            &["/", "/photo/1"],
        );
        assert_eq!(
            host.redirects,
            "/old/* /new/:splat 308\n/blog/:slug https://example.com/b/:slug 301\n/p/:id /photo/:id 200\n/x /nowhere 200\n"
        );
        assert_eq!(
            host.headers,
            "/api/*\n  Cache-Control: no-store\n  X-Frame-Options: DENY\n"
        );
        let warned = |s: &str| host.warnings.iter().any(|w| w.contains(s));
        assert!(warned("/og/[card].png"));
        assert!(warned("/x → /nowhere"));
        assert!(!warned("/p/[id]"));
        assert!(warned("x-frame-options"));
    }

    #[test]
    fn static_host_rules_carry_base_path_and_warn() {
        let host = static_host_rules(
            &routing(
                r#"{"basePath":"/app","trailingSlash":"always",
                "redirects":[{"source":"/","destination":"/home","status":307}]}"#,
            ),
            &["/home"],
        );
        assert_eq!(host.redirects, "/app /app/home 307\n");
        assert!(host.warnings.iter().any(|w| w.contains("basePath")));
        // The file layout carries the trailing-slash policy (out_file_for), so no warning.
        assert!(!host.warnings.iter().any(|w| w.contains("trailingSlash")));
        assert!(static_host_rules(&routing("{}"), &[]).redirects.is_empty());
        assert!(static_host_rules(&routing("{}"), &[]).warnings.is_empty());
    }

    #[test]
    fn output_files_follow_the_trailing_slash_policy() {
        let out = Path::new("out");
        let file = |url: &str, t| out_file_for(out, url, t);
        for t in [TrailingSlash::Ignore, TrailingSlash::Always] {
            assert_eq!(file("/", t), out.join("index.html"));
            assert_eq!(file("/about", t), out.join("about/index.html"));
            assert_eq!(file("/docs/a", t), out.join("docs/a/index.html"));
        }
        assert_eq!(file("/", TrailingSlash::Never), out.join("index.html"));
        assert_eq!(file("/about", TrailingSlash::Never), out.join("about.html"));
        assert_eq!(
            file("/docs/a", TrailingSlash::Never),
            out.join("docs/a.html")
        );
        // Dynamic pages from static-paths.mjs (decoded, already `x/index.html`).
        assert_eq!(
            page_file("blog/a b/index.html", TrailingSlash::Never),
            "blog/a b.html"
        );
        assert_eq!(
            page_file("blog/a b/index.html", TrailingSlash::Ignore),
            "blog/a b/index.html"
        );
        assert_eq!(page_file("index.html", TrailingSlash::Never), "index.html");
    }
}
