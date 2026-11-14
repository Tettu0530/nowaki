//! Terminal output: colors, the server banner, the build report. No color without a TTY or with
//! `NO_COLOR`; the text reads the same without it.

use std::io::IsTerminal;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, UdpSocket};

fn color() -> bool {
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none()
}

fn paint(code: &str, s: &str) -> String {
    if color() {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

pub fn cyan(s: &str) -> String {
    paint("36", s)
}
pub fn dim(s: &str) -> String {
    paint("2", s)
}
pub fn bold(s: &str) -> String {
    paint("1", s)
}
pub fn green(s: &str) -> String {
    paint("32", s)
}
pub fn yellow(s: &str) -> String {
    paint("33", s)
}
pub fn red(s: &str) -> String {
    paint("31", s)
}

/// Logs one HMR message for the changed files. `kind` is "hot" (modules swapped in place), "css"
/// (stylesheets replaced), "page" (the page HTML refetched and morphed) or "reload" (a full
/// reload).
pub fn hmr_log(kind: &str, files: &[String]) {
    let list = files.join(", ");
    if matches!(kind, "hot" | "css") {
        println!("  {} {}  {}", cyan("hmr"), dim(kind), list);
    } else {
        println!("  {} {}  {}", yellow("hmr"), dim(kind), list);
    }
}

/// One dev request line: method, path, status (colored by class) and duration.
pub fn request_log(method: &str, path: &str, status: u16, ms: u128) {
    let code = status.to_string();
    let st = if status < 300 {
        green(&code)
    } else if status < 400 {
        yellow(&code)
    } else {
        red(&code)
    };
    println!(
        "  {} {}  {}  {}",
        dim(method),
        path,
        st,
        dim(&format!("{ms} ms")),
    );
}

/// Guesses the LAN IPv4 (a UDP connect only looks up the route; no packets are sent).
pub fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() => Some(v4.to_string()),
        _ => None,
    }
}

/// Total size of the `.js` files directly in `dir`, in KB (minified, not compressed).
pub fn dir_js_kb(dir: &std::path::Path) -> f64 {
    let mut bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("js") {
                if let Ok(m) = std::fs::metadata(&p) {
                    bytes += m.len();
                }
            }
        }
    }
    bytes as f64 / 1024.0
}

/// First-load JS per page route (gzip), with its budget when the route sets one. Returns how many
/// routes are over budget; the caller fails the build on any.
pub fn route_js_report(routes: &[nowaki_core::budget::RouteJs]) -> usize {
    if routes.is_empty() {
        return 0;
    }
    let width = routes.iter().map(|r| r.url.len()).max().unwrap_or(1).max(5);
    println!("  {}", bold("first-load JS per route (gzip):"));
    let mut over = 0;
    for r in routes {
        let size = format!("{:>7.2} KB", r.kb());
        let note = match r.budget_kb {
            Some(b) if r.over_budget() => {
                over += 1;
                red(&format!("over budget {b} KB"))
            }
            Some(b) => dim(&format!("budget {b} KB")),
            None => String::new(),
        };
        let what = if r.islands.is_empty() && !r.live && r.gzip_bytes > 0 {
            // No island: page scripts, or the islands runtime a streaming shell always loads.
            dim("page scripts / streaming shell runtime")
        } else if r.islands.is_empty() && !r.live {
            dim("no client JS")
        } else {
            let mut parts = r.islands.clone();
            if r.live {
                parts.push("live".into());
            }
            dim(&parts.join(", "))
        };
        println!("    {:<width$}  {size}  {note}  {what}", r.url);
    }
    println!();
    over
}

/// The `nowaki build` summary: module and island counts, client JS size, image savings, build
/// time and the output directory.
#[allow(clippy::too_many_arguments)]
pub fn build_summary(
    client_modules: usize,
    islands: usize,
    server_modules: usize,
    client_js_kb: f64,
    ms: u128,
    out: &std::path::Path,
    asset_in: u64,
    asset_out: u64,
) {
    println!();
    println!(
        "  {} {}",
        bold(&cyan("Nowaki")),
        dim(&format!("built in {ms} ms"))
    );
    println!();
    println!(
        "  {}  {}  {}",
        green("➜"),
        bold("client:"),
        dim(&format!(
            "{client_modules} modules · {islands} island(s) · {client_js_kb:.1} KB JS"
        )),
    );
    println!(
        "  {}  {}  {}",
        green("➜"),
        bold("server:"),
        dim(&format!("{server_modules} modules")),
    );
    if asset_in > asset_out {
        let saved = asset_in - asset_out;
        let pct = saved as f64 / asset_in as f64 * 100.0;
        println!(
            "  {}  {}  {}",
            green("➜"),
            bold("assets:"),
            dim(&format!(
                "optimized images · saved {:.1} KB ({pct:.0}%)",
                saved as f64 / 1024.0
            )),
        );
    }
    println!(
        "  {}  {}  {}",
        green("➜"),
        bold("output:"),
        cyan(&out.display().to_string()),
    );
    println!();
}

/// The URL to open this machine's browser at for a server listening on `bind`.
pub fn browser_url(bind: IpAddr, port: u16) -> String {
    let bind = bind.to_canonical();
    if bind.is_unspecified() || bind == Ipv4Addr::LOCALHOST || bind == Ipv6Addr::LOCALHOST {
        format!("http://localhost:{port}/")
    } else {
        format!("http://{}:{port}/", crate::listen::url_host(bind))
    }
}

/// Prints the startup banner. `bind` is the address the server listens on: all interfaces
/// (`0.0.0.0` / `::`) show the Local and the LAN URL, a loopback address the Local URL, any other
/// address its own Network URL. `mcp` is `nowaki dev`'s MCP endpoint, shown with the command that
/// registers it with Claude Code.
pub fn server_banner(
    label: &str,
    version: &str,
    port: u16,
    ready_ms: u128,
    features: &[&str],
    bind: IpAddr,
    mcp: Option<&str>,
) {
    let bind = bind.to_canonical();
    println!();
    println!("  {} {}", bold(&cyan(label)), dim(&format!("v{version}")));
    println!();
    if bind.is_unspecified() || bind.is_loopback() {
        println!(
            "  {}  {}    {}",
            green("➜"),
            bold("Local:"),
            cyan(&browser_url(bind, port)),
        );
    }
    if bind.is_unspecified() {
        if let Some(ip) = lan_ip() {
            println!(
                "  {}  {}  {}",
                green("➜"),
                bold("Network:"),
                cyan(&format!("http://{ip}:{port}/")),
            );
        }
    } else if !bind.is_loopback() {
        println!(
            "  {}  {}  {}",
            green("➜"),
            bold("Network:"),
            cyan(&browser_url(bind, port)),
        );
    } else {
        println!(
            "  {}  {}  {}",
            dim("➜"),
            dim("Network:"),
            dim("use --host to expose"),
        );
    }
    if let Some(url) = mcp {
        println!("  {}  {}      {}", green("➜"), bold("MCP:"), cyan(url));
        println!(
            "               {}",
            dim(&format!("claude mcp add --transport http nowaki {url}"))
        );
    }
    // "ready in" is also the marker the benchmarks (bench.mjs / head-to-head.mjs) wait for.
    println!(
        "  {}  ready in {}",
        green("➜"),
        bold(&format!("{ready_ms} ms"))
    );
    if !features.is_empty() {
        println!();
        println!("  {}", dim(&features.join(" · ")));
    }
    println!();
}

/// Opens `url` in the default browser (`open`, `start` or `xdg-open`); failures are ignored.
pub fn open_browser(url: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    let _ = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}
