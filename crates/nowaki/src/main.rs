mod adapter;
mod content;
mod csp;
mod dev;
mod encoding;
mod env_schema;
mod fonts;
mod forward;
mod front;
mod live;
mod mcp;
mod obs;
mod plugins;
mod prerender;
mod remote_images;
mod runtime;
mod security_headers;
mod shutdown;
mod sidecar;
mod site;
mod start;
mod typegen;
mod ui;
mod upgrade;

use std::path::PathBuf;

use adapter::Adapter;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "nowaki",
    version,
    about = "Nowaki — a full-stack framework built on a Rust toolchain"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start the dev server
    Dev {
        /// App root directory
        #[arg(default_value = ".")]
        dir: PathBuf,
        #[arg(short, long, default_value_t = 3000)]
        port: u16,
        /// Expose on the LAN (listen on 0.0.0.0, show the Network URL)
        #[arg(long)]
        host: bool,
        /// Open the default browser after startup
        #[arg(long)]
        open: bool,
    },
    /// Build for production and emit output for the deploy adapter
    Build {
        /// App root directory
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// Deploy target adapter (node|static|bun|deno|cloudflare|vercel)
        #[arg(long, value_enum, default_value_t = Adapter::Node)]
        adapter: Adapter,
    },
    /// Serve a built app in production mode
    Start {
        /// App root directory
        #[arg(default_value = ".")]
        dir: PathBuf,
        #[arg(short, long, default_value_t = 3000)]
        port: u16,
        /// Listen on all interfaces (default: NOWAKI_HOST or 127.0.0.1)
        #[arg(long)]
        host: bool,
    },
    /// Prerender as a static site (SSG)
    Prerender {
        /// App root directory
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// Output directory (relative to dir, or absolute)
        #[arg(short, long, default_value = "dist/static")]
        out: PathBuf,
        /// Render from existing `dist/` (`nowaki build`); skips the transform and content-index steps
        #[arg(long)]
        skip_build: bool,
    },
    /// Update nowaki (CLI) and @nowaki-dev/runtime to the latest version
    Upgrade {
        /// App root directory
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// Version to update to (default: latest), e.g. --to 0.11.0
        #[arg(long)]
        to: Option<String>,
    },
    /// Generate typed routes (.nowaki/types.d.ts)
    Typegen {
        /// App root directory
        #[arg(default_value = ".")]
        dir: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Dev {
            dir,
            port,
            host,
            open,
        } => {
            let root = dunce::canonicalize(&dir)?;
            runtime::check(&root)?;
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(dev::run(root, port, host, open))
        }
        Command::Build { dir, adapter } => {
            let root = dunce::canonicalize(&dir)?;
            runtime::check(&root)?;
            // The static adapter delegates to prerender (build → temporary server → render each route).
            if adapter == Adapter::Static {
                typegen::write(&root)?;
                let out = root.join("dist/static");
                return tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()?
                    .block_on(prerender::run(root.clone(), out, false));
            }
            // One Node process imports nowaki.config for the plugins and the build-time config,
            // starting while typegen runs and env.ts is checked (in another Node process).
            let plugin_host = plugins::spawn(&root, true)?;
            let env_check = env_schema::start(&root)?;
            typegen::write(&root)?;
            let dist = root.join("dist");
            // Before the build: an invalid config fails before anything is built. The host stays
            // alive until the build finishes (drop kills it).
            let (plugin_host, config) = plugin_host.finish()?;
            let config = config?;
            let mut core = nowaki_core::NowakiCore::new(root.clone());
            if let Some(host) = &plugin_host {
                core.set_plugins(host.bridge.clone());
            }
            // env.ts: validated before the build, which inlines its public values.
            env_schema::finish(env_check, &mut core)?;
            remote_images::configure(&mut core, &root, &config)?;
            site::configure(&mut core, &config)?;
            let started = std::time::Instant::now();
            let (report, client) = core.build_with_client(&dist)?;
            let client_js_kb = ui::dir_js_kb(&report.out_dir);
            ui::build_summary(
                report.modules,
                report.islands,
                report.server_modules,
                client_js_kb,
                started.elapsed().as_millis(),
                &dist,
                report.asset_in,
                report.asset_out,
            );
            content::build(&root, &dist, &config)?;
            site::write(&dist, &config)?;
            fonts::build_dist(&root, &dist, &config)?;
            check_route_budgets(&core, &report, &client)?;
            print_island_hints(&core, &report.out_dir);
            let unvalidated = nowaki_core::server_fn::discover_unvalidated(
                &core,
                &["routes", "islands", "components", "lib", "actions"],
            );
            if !unvalidated.is_empty() {
                eprintln!(
                    "[nowaki] warning: {} server function(s) take unvalidated input: {}. Wrap them with serverFn(schema, impl) (any Standard Schema library).",
                    unvalidated.len(),
                    unvalidated.join(", ")
                );
            }
            match adapter {
                Adapter::Cloudflare => adapter::emit_cloudflare(&root, &dist)?,
                Adapter::Vercel => adapter::emit_vercel(&root, &dist)?,
                _ => adapter::emit_server(&root, &dist, adapter)?,
            }
            Ok(())
        }
        Command::Start { dir, port, host } => {
            let root = dunce::canonicalize(&dir)?;
            runtime::check(&root)?;
            // Rust (axum) serves static files + assembles HTML; the Node prod-sidecar renders components.
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(start::run(root, port, host))
        }
        Command::Prerender {
            dir,
            out,
            skip_build,
        } => {
            let root = dunce::canonicalize(&dir)?;
            runtime::check(&root)?;
            let out = if out.is_absolute() {
                out
            } else {
                root.join(out)
            };
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(prerender::run(root, out, skip_build))
        }
        Command::Upgrade { dir, to } => {
            let root = dunce::canonicalize(&dir)?;
            upgrade::run(root, to)
        }
        Command::Typegen { dir } => {
            let root = dunce::canonicalize(&dir)?;
            typegen::run(root)
        }
    }
}

/// Prints first-load JS per page route and fails the build when a route's
/// `export const budget = { js: <KB> }` is exceeded.
fn check_route_budgets(
    core: &nowaki_core::NowakiCore,
    report: &nowaki_core::build::BuildReport,
    client: &nowaki_core::build::ClientInfo,
) -> anyhow::Result<()> {
    let routes = nowaki_core::budget::route_first_load(core, client, &report.out_dir)?;
    // Machine-readable copy for tooling and CI (outside dist/client, so it is never served).
    let json: Vec<_> = routes
        .iter()
        .map(|r| {
            serde_json::json!({
                "url": r.url, "file": r.file, "gzipBytes": r.gzip_bytes,
                "budgetKB": r.budget_kb, "islands": r.islands, "live": r.live,
                "chunks": r.chunks,
            })
        })
        .collect();
    if let Some(dist) = report.out_dir.parent() {
        std::fs::write(
            dist.join("route-js.json"),
            serde_json::to_string_pretty(&json)?,
        )?;
    }
    let over = ui::route_js_report(&routes);
    if over > 0 {
        anyhow::bail!(
            "{over} route(s) over their JS budget (`export const budget`). Shrink their islands or raise the budget."
        );
    }
    Ok(())
}

/// Points out client islands that could ship no JS: ones that only keep state and handle
/// click / form events (a live island does the same on the server), and ones with no state or
/// events at all (a plain component). `NOWAKI_HINTS=0` turns this off.
fn print_island_hints(core: &nowaki_core::NowakiCore, client_dir: &std::path::Path) {
    if matches!(
        std::env::var("NOWAKI_HINTS").ok().as_deref(),
        Some("0" | "off" | "false")
    ) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(client_dir.join("manifest.json")) else {
        return;
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(islands) = manifest.get("islands").and_then(|v| v.as_object()) else {
        return;
    };
    let islands_dir = core.root.join("islands");
    let Ok(entries) = std::fs::read_dir(&islands_dir) else {
        return;
    };
    let mut files: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    files.sort();
    let mut lines = Vec::new();
    for path in files {
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(chunk) = islands.get(name).and_then(|v| v.as_str()) else {
            continue; // live islands, or files that aren't islands
        };
        let Ok(source) = core.read_source(&path) else {
            continue;
        };
        let Some(hint) = nowaki_core::live_hint::hint_for_island(&path, &source) else {
            continue;
        };
        let kb = std::fs::read(client_dir.join(chunk))
            .map(|b| nowaki_core::compress::gzip(&b, 9).len() as f64 / 1024.0)
            .unwrap_or(0.0);
        let file = format!("islands/{}", path.file_name().unwrap().to_string_lossy());
        lines.push(match hint.kind {
            nowaki_core::live_hint::HintKind::CouldBeLive => format!(
                "{file} could be a live island ({}): rewritten with `export const live` (state on the server, `data-live` events) it ships none of its {kb:.2} KB, nor the islands runtime on pages where it is the only client island; each event becomes a server round trip",
                hint.uses.join(", ")
            ),
            nowaki_core::live_hint::HintKind::NoInteractivity => format!(
                "{file} has no state or event handlers: as a plain component (outside islands/) it would ship none of its {kb:.2} KB of JS"
            ),
        });
    }
    if lines.is_empty() {
        return;
    }
    println!("  {}", ui::bold("hints (NOWAKI_HINTS=0 hides these):"));
    for l in lines {
        println!("    {}", ui::dim(&l));
    }
    println!();
}
