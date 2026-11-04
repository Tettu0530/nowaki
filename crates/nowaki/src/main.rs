mod adapter;
mod csp;
mod dev;
mod forward;
mod live;
mod plugins;
mod prerender;
mod security_headers;
mod shutdown;
mod sidecar;
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
        /// Fail the build when a route exceeds `export const budget` (gzip first-load JS).
        #[arg(long)]
        strict_budget: bool,
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
        /// Fail the build when a route exceeds `export const budget` (gzip first-load JS).
        #[arg(long)]
        strict_budget: bool,
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

fn strict_route_budget(cli: bool) -> bool {
    cli || std::env::var("NOWAKI_BUDGET_STRICT")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"))
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
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(dev::run(root, port, host, open))
        }
        Command::Build {
            dir,
            adapter,
            strict_budget,
        } => {
            let root = dunce::canonicalize(&dir)?;
            typegen::write(&root)?;
            // The static adapter delegates to prerender (build → temporary server → render each route).
            if adapter == Adapter::Static {
                let out = root.join("dist/static");
                let strict_budget = strict_route_budget(strict_budget);
                return tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()?
                    .block_on(prerender::run(root.clone(), out, strict_budget));
            }
            let dist = root.join("dist");
            // Keep alive until the build finishes (drop kills the host).
            let plugin_host = plugins::start(&root)?;
            let mut core = nowaki_core::NowakiCore::new(root.clone());
            if let Some(host) = &plugin_host {
                core.set_plugins(host.bridge.clone());
            }
            let started = std::time::Instant::now();
            let strict_budget = strict_route_budget(strict_budget);
            let report = core.build(&dist, nowaki_core::BuildOptions { strict_budget })?;
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
            // Rust (axum) serves static files + assembles HTML; the Node prod-sidecar renders components.
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(start::run(root, port, host))
        }
        Command::Prerender {
            dir,
            out,
            strict_budget,
        } => {
            let root = dunce::canonicalize(&dir)?;
            let out = if out.is_absolute() {
                out
            } else {
                root.join(out)
            };
            let strict_budget = strict_route_budget(strict_budget);
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(prerender::run(root, out, strict_budget))
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
