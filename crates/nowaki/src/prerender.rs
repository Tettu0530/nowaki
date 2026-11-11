use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use nowaki_core::rules::{I18nConfig, TrailingSlash};
use nowaki_core::NowakiCore;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

/// Pages requested from the temporary prod server at once.
const PRERENDER_JOBS: usize = 8;

/// Use multiple Node render workers when the page count is at least this many (`NOWAKI_PRERENDER_POOL_THRESHOLD=0` disables the pool).
const DEFAULT_POOL_THRESHOLD: usize = 256;

struct ProdServer {
    child: Child,
    port: u16,
    drain: tokio::task::JoinHandle<()>,
}

/// How many Node `start.mjs` processes to run for HTML rendering (always 1 below the pool threshold).
fn render_worker_count(
    page_count: usize,
    pool_threshold: usize,
    parallelism: usize,
    max_workers: Option<usize>,
) -> usize {
    if pool_threshold == 0 || page_count < pool_threshold {
        return 1;
    }
    let cap = max_workers.unwrap_or(parallelism).max(1);
    page_count.min(cap).max(1)
}

fn pool_settings() -> (usize, Option<usize>) {
    let threshold = std::env::var("NOWAKI_PRERENDER_POOL_THRESHOLD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_POOL_THRESHOLD);
    let max_workers = std::env::var("NOWAKI_PRERENDER_WORKERS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0);
    (threshold, max_workers)
}

fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// Static site generation: build → start a temporary prod server → render each static route to HTML → write out.
/// With `skip_build`, the transform/content steps are skipped and existing `dist/` is used (must be from `nowaki build`).
pub async fn run(root: PathBuf, out: PathBuf, skip_build: bool) -> Result<()> {
    // Checked before building: the build writes dist/, and clearing `out` must never reach it.
    let clear_out = check_out(&root, &out)?;
    if skip_build {
        ensure_built(&root)?;
        let env_check = crate::env_schema::start(&root)?;
        crate::env_schema::finish_skip_build(env_check, &root)?;
        println!("[nowaki] prerender: using existing dist/ (--skip-build)");
    } else {
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
        crate::site::configure(&mut core, &config)?;
        let (report, client) = core.build_with_client(&root.join("dist"))?;
        println!(
            "[nowaki] build: client {} / server {} modules",
            report.modules, report.server_modules
        );
        crate::content::build(&root, &root.join("dist"), &config)?;
        crate::site::write(&root.join("dist"), &config)?;
        crate::fonts::build_dist(&root, &root.join("dist"), &config)?;
        crate::check_route_budgets(&core, &report, &client)?;
    }
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

    // static-paths and route enumeration only read dist/; one Node server can start alongside them.
    let routes_dir = root.join("dist/server/routes");
    let (dynamic_pages, static_urls, first_server) = tokio::join!(
        static_paths(&root),
        async { nowaki_core::routes::enumerate_static_prerender_urls(&routes_dir) },
        start_prod_server(&root, &entry),
    );
    let dynamic_pages = dynamic_pages?;
    let static_urls = static_urls?;
    let first_server = first_server?;

    let i18n = read_i18n(&routing_file);
    let mut pages: Vec<(String, PathBuf)> = locale_urls(i18n.as_ref(), static_urls)
        .into_iter()
        .map(|url| {
            let file = out_file_for(&out, &url, trailing);
            (url, file)
        })
        .collect();
    for (url, file, page) in dynamic_pages {
        let file = if page {
            out.join(page_file(&file, trailing))
        } else {
            out.join(file)
        };
        pages.push((url, file));
    }
    if pages.is_empty() {
        return Err(anyhow!("no static routes to prerender"));
    }

    let (pool_threshold, max_workers) = pool_settings();
    let workers = render_worker_count(
        pages.len(),
        pool_threshold,
        available_parallelism(),
        max_workers,
    );
    let mut servers = vec![first_server];
    if workers > servers.len() {
        let extra = futures_util::future::try_join_all(
            (servers.len()..workers).map(|_| start_prod_server(&root, &entry)),
        )
        .await?;
        servers.extend(extra);
    }
    if workers > 1 {
        println!(
            "[nowaki] prerender: {workers} Node render workers ({} pages, pool threshold {pool_threshold})",
            pages.len()
        );
    }
    let ports: Vec<u16> = servers.iter().map(|s| s.port).collect();
    let primary_port = ports[0];
    let render_jobs = workers.saturating_mul(PRERENDER_JOBS);

    // Don't follow redirects; skip non-200 responses.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    // Output under dist/ (the static adapter) is ours to replace; a user-chosen `--out` is not.
    if clear_out {
        nowaki_core::build::clear_dir(&out)?;
    }
    std::fs::create_dir_all(&out)?;
    // A few requests in flight keep each single-threaded renderer busy while Rust waits on the
    // socket and writes files (2 already saturates a plain app; I/O-bound loaders gain more).
    // Round-robin workers when the pool is on; `buffered` keeps the original order, so logs and
    // the first error stay deterministic.
    let mut rendered = futures_util::stream::iter(pages.iter().enumerate())
        .map(|(i, (url_path, file))| {
            let client = client.clone();
            let url_path = url_path.clone();
            let file = file.clone();
            let port = ports[i % ports.len()];
            let request = request_path(&url_path);
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
                Ok(Some((url_path, live)))
            }
        })
        .buffered(render_jobs);
    let mut count = 0;
    let mut live_pages = Vec::new();
    while let Some(written) = rendered.next().await {
        if let Some((url, live)) = written? {
            count += 1;
            if live {
                live_pages.push(url);
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
            .get(format!(
                "http://127.0.0.1:{primary_port}{}",
                request_path(url)
            ))
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
            .get(format!(
                "http://127.0.0.1:{primary_port}{}",
                request_path("/404")
            ))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            std::fs::write(out.join("404.html"), resp.text().await?)?;
        }
        // i18n: one per locale directory, rendered in that locale.
        for (url, file) in locale_404s(i18n.as_ref()) {
            let resp = client
                .get(format!(
                    "http://127.0.0.1:{primary_port}{}",
                    request_path(&url)
                ))
                .send()
                .await?;
            if resp.status() == reqwest::StatusCode::NOT_FOUND {
                let file = out.join(file);
                if let Some(parent) = file.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(file, resp.text().await?)?;
            }
        }
    }

    // The SPA router fetches this once; a static host has no server to answer it.
    let boundaries = client
        .get(format!(
            "http://127.0.0.1:{primary_port}/__nowaki/boundaries"
        ))
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
    // Hashed client chunks are immutable; hard links avoid duplicating them under `out/_nowaki`
    // when `dist/client` lives on the same filesystem (falls back to copy on EXDEV).
    link_client_dir(&root.join("dist/client"), &assets)?;
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
    let locale_redirects = locale_redirects(routing.i18n.as_ref(), &routing.base_path);
    if !own_redirects.is_empty() || !host.redirects.is_empty() || !locale_redirects.is_empty() {
        std::fs::write(
            out.join("_redirects"),
            format!("{own_redirects}{}{locale_redirects}", host.redirects),
        )?;
    }
    // The host serves the output at basePath, so its paths carry it.
    let base = routing.base_path.as_str();
    std::fs::write(
        out.join("_headers"),
        format!(
            "{own_headers}/*\n{}{base}/_nowaki/*\n  Cache-Control: public, max-age=31536000, immutable\n{base}/__nowaki/boundaries\n  Content-Type: application/json\n{}",
            static_security_headers(),
            host.headers
        ),
    )?;

    for server in servers {
        stop_prod_server(server).await;
    }
    println!("[nowaki] prerender done: {count} pages → {}", out.display());
    Ok(())
}

/// `dist/client` and `dist/server/routes` must exist (`nowaki build` output).
fn ensure_built(root: &Path) -> Result<()> {
    let dist = root.join("dist");
    if !dist.join("client/manifest.json").is_file() {
        anyhow::bail!(
            "Not built yet. Run `nowaki build {}` first, or omit --skip-build.",
            root.display()
        );
    }
    if !dist.join("server/routes").is_dir() {
        anyhow::bail!(
            "dist/server/routes is missing (incomplete build). Run `nowaki build {}` first.",
            root.display()
        );
    }
    Ok(())
}

async fn start_prod_server(root: &Path, entry: &Path) -> Result<ProdServer> {
    let mut child = Command::new("node")
        .arg("--enable-source-maps")
        .arg(entry)
        .current_dir(root)
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
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    let port = loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).await? == 0 {
            return Err(anyhow!("prod server exited without reporting READY"));
        }
        let text = String::from_utf8_lossy(&line);
        if let Some(rest) = text.trim_end().strip_prefix("NOWAKI_START_READY ") {
            break rest.trim().parse::<u16>().context("failed to parse port")?;
        }
        print!("{text}"); // the app's own logs
    };
    let drain = spawn_stdout_drain(reader);
    Ok(ProdServer { child, port, drain })
}

/// Keep draining the server's stdout for the whole run: Node writes to a pipe synchronously on
/// Linux, so once app logs fill it (~64 KiB) the renderer would block and every request would hang.
fn spawn_stdout_drain(
    mut server_out: BufReader<tokio::process::ChildStdout>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        let mut stdout = tokio::io::stdout();
        let mut forward = true;
        while let Ok(n @ 1..) = server_out.read(&mut buf).await {
            if forward {
                forward = stdout.write_all(&buf[..n]).await.is_ok();
            }
        }
    })
}

async fn stop_prod_server(mut server: ProdServer) {
    let grace = std::time::Duration::from_secs(5);
    drop(server.child.stdin.take());
    let _ = tokio::time::timeout(grace, server.child.wait()).await;
    if tokio::time::timeout(grace, &mut server.drain)
        .await
        .is_err()
    {
        server.drain.abort();
    }
    drop(server.child);
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

/// i18n: the locale settings of the routing config, if any.
fn read_i18n(routing_file: &Path) -> Option<I18nConfig> {
    let text = std::fs::read_to_string(routing_file).ok()?;
    serde_json::from_str::<nowaki_core::rules::RoutingConfig>(&text)
        .ok()?
        .i18n
}

/// i18n: each page URL in every locale, in config order (`/about` → `/about`, `/ja/about`).
fn locale_urls(i18n: Option<&I18nConfig>, urls: Vec<String>) -> Vec<String> {
    let Some(i18n) = i18n else {
        return urls;
    };
    urls.iter()
        .flat_map(|url| i18n.locales.iter().map(move |l| locale_url(i18n, url, l)))
        .collect()
}

/// A route path (no locale in it) as `locale`'s URL: the default locale has no prefix unless
/// `prefixDefaultLocale`. The runtime's `localePathFor` (server/i18n.mjs) builds the same URLs;
/// tests/fixtures/i18n-cases.json drives both.
fn locale_url(i18n: &I18nConfig, url: &str, locale: &str) -> String {
    if locale == i18n.default_locale && !i18n.prefix_default_locale {
        url.to_string()
    } else if url == "/" {
        format!("/{locale}")
    } else {
        format!("/{locale}{url}")
    }
}

/// i18n: the 404 page of each locale directory, as (request path, file under the output dir).
/// The unprefixed default locale's is the top-level 404.html.
fn locale_404s(i18n: Option<&I18nConfig>) -> Vec<(String, String)> {
    let Some(i18n) = i18n else {
        return Vec::new();
    };
    i18n.locales
        .iter()
        .filter(|l| **l != i18n.default_locale || i18n.prefix_default_locale)
        .map(|l| (format!("/{l}/404"), format!("{l}/404.html")))
        .collect()
}

/// i18n: `_redirects` lines sending the default locale's prefix to the unprefixed URL (308), as the
/// servers do. None with `prefixDefaultLocale`.
fn locale_redirects(i18n: Option<&I18nConfig>, base: &str) -> String {
    match i18n {
        Some(i18n) if !i18n.prefix_default_locale => {
            let l = &i18n.default_locale;
            let root = if base.is_empty() { "/" } else { base };
            format!("{base}/{l} {root} 308\n{base}/{l}/* {base}/:splat 308\n")
        }
        _ => String::new(),
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
    if config.i18n.as_ref().is_some_and(|i| i.detect) {
        out.warnings.push(
            "i18n.detect: a static host can't read Accept-Language or the nowaki_locale cookie, so / always serves the default locale (detection needs `nowaki start` or a server adapter)".to_string(),
        );
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

fn link_client_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            std::fs::create_dir_all(&dst)?;
            link_client_dir(&src, &dst)?;
        } else {
            hard_link_or_copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Hard-link `src` to `dst` when both paths share a volume; otherwise copy the file bytes.
fn hard_link_or_copy(src: &Path, dst: &Path) -> Result<()> {
    match std::fs::hard_link(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if hard_link_copy_fallback(&e) => {
            std::fs::copy(src, dst)?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

fn hard_link_copy_fallback(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::CrossesDevices | std::io::ErrorKind::Unsupported
    ) || (cfg!(windows) && err.raw_os_error() == Some(17)) // ERROR_NOT_SAME_DEVICE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_worker_count_respects_threshold_and_cap() {
        assert_eq!(render_worker_count(10, 256, 8, None), 1);
        assert_eq!(render_worker_count(255, 256, 8, None), 1);
        assert_eq!(render_worker_count(256, 256, 8, None), 8);
        assert_eq!(render_worker_count(500, 256, 8, None), 8);
        assert_eq!(render_worker_count(3, 256, 8, None), 1);
        assert_eq!(render_worker_count(500, 256, 4, Some(2)), 2);
        assert_eq!(render_worker_count(1, 256, 8, Some(4)), 1);
        assert_eq!(render_worker_count(500, 0, 8, None), 1);
        assert_eq!(render_worker_count(10_000, 100, 6, None), 6);
    }

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

    #[test]
    fn skip_build_requires_a_prior_build() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(ensure_built(root).is_err());
        std::fs::create_dir_all(root.join("dist/client")).unwrap();
        std::fs::write(root.join("dist/client/manifest.json"), "{}").unwrap();
        assert!(ensure_built(root).is_err());
        std::fs::create_dir_all(root.join("dist/server/routes")).unwrap();
        ensure_built(root).unwrap();
    }

    #[test]
    fn client_dir_uses_hard_links_on_the_same_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("client");
        let to = dir.path().join("out/_nowaki");
        std::fs::create_dir_all(from.join("sub")).unwrap();
        std::fs::write(from.join("sub/a.js"), b"chunk").unwrap();
        std::fs::write(from.join("manifest.json"), b"{}").unwrap();
        link_client_dir(&from, &to).unwrap();
        assert_eq!(
            std::fs::read_to_string(to.join("sub/a.js")).unwrap(),
            "chunk"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                std::fs::metadata(from.join("sub/a.js")).unwrap().ino(),
                std::fs::metadata(to.join("sub/a.js")).unwrap().ino()
            );
        }
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
        let detect = static_host_rules(
            &routing(r#"{"i18n":{"locales":["en","ja"],"defaultLocale":"en","detect":true}}"#),
            &[],
        );
        assert!(detect.warnings.iter().any(|w| w.contains("i18n.detect")));
        let no_detect = static_host_rules(
            &routing(r#"{"i18n":{"locales":["en","ja"],"defaultLocale":"en"}}"#),
            &[],
        );
        assert!(no_detect.warnings.is_empty());
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

    fn i18n(json: &str) -> I18nConfig {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn locale_urls_follow_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/i18n-cases.json")).unwrap();
        let mut n = 0;
        for case in fixture["localePath"].as_array().unwrap() {
            // JS-only cases: paths that already carry a locale, a query, or aren't route paths.
            if case["js"] == true {
                continue;
            }
            let config = i18n(&fixture["configs"][case["config"].as_str().unwrap()].to_string());
            let got = locale_url(
                &config,
                case["path"].as_str().unwrap(),
                case["locale"].as_str().unwrap(),
            );
            assert_eq!(got, case["expected"].as_str().unwrap(), "{case}");
            n += 1;
        }
        assert!(n >= 10);
    }

    #[test]
    fn locale_expansion_404s_and_redirects() {
        let plain = i18n(r#"{"locales":["en","ja"],"defaultLocale":"en"}"#);
        assert_eq!(
            locale_urls(Some(&plain), vec!["/".into(), "/about".into()]),
            ["/", "/ja", "/about", "/ja/about"]
        );
        assert_eq!(
            locale_urls(None, vec!["/about".into()]),
            ["/about".to_string()]
        );
        assert_eq!(
            locale_404s(Some(&plain)),
            [("/ja/404".to_string(), "ja/404.html".to_string())]
        );
        assert!(locale_404s(None).is_empty());
        assert_eq!(
            locale_redirects(Some(&plain), ""),
            "/en / 308\n/en/* /:splat 308\n"
        );
        assert_eq!(
            locale_redirects(Some(&plain), "/app"),
            "/app/en /app 308\n/app/en/* /app/:splat 308\n"
        );
        let prefixed =
            i18n(r#"{"locales":["en","ja"],"defaultLocale":"en","prefixDefaultLocale":true}"#);
        assert_eq!(locale_404s(Some(&prefixed)).len(), 2);
        assert!(locale_redirects(Some(&prefixed), "").is_empty());
        assert!(locale_redirects(None, "").is_empty());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("routing.json");
        assert!(read_i18n(&file).is_none());
        std::fs::write(
            &file,
            r#"{"i18n":{"locales":["en","ja"],"defaultLocale":"en"}}"#,
        )
        .unwrap();
        assert_eq!(read_i18n(&file).unwrap().locales, ["en", "ja"]);
    }
}
