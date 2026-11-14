mod adapter;
mod content;
mod csp;
mod dev;
mod encoding;
mod env_schema;
mod fonts;
mod form_body;
mod forward;
mod front;
mod listen;
mod live;
mod mcp;
mod obs;
mod plugins;
mod prerender;
mod readiness;
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
        /// Port to listen on (default: PORT, else 3000)
        #[arg(short, long)]
        port: Option<u16>,
        /// Address to listen on; `--host` alone listens on all interfaces (0.0.0.0) [default: NOWAKI_HOST, else 127.0.0.1]
        #[arg(long, value_name = "ADDR", num_args = 0..=1, default_missing_value = listen::ALL_INTERFACES)]
        host: Option<String>,
        /// Open the default browser after startup
        #[arg(long)]
        open: bool,
        /// Don't load the dev toolbar in the browser (same as NOWAKI_TOOLBAR=0)
        #[arg(long)]
        no_toolbar: bool,
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
        /// Port to listen on (default: PORT, else 3000)
        #[arg(short, long)]
        port: Option<u16>,
        /// Address to listen on; `--host` alone listens on all interfaces (0.0.0.0) [default: NOWAKI_HOST, else 127.0.0.1]
        #[arg(long, value_name = "ADDR", num_args = 0..=1, default_missing_value = listen::ALL_INTERFACES)]
        host: Option<String>,
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
        /// Version or npm dist-tag to update to (default: latest), e.g. --to 1.0.0 or --to next. A version on a newer major first prints a readiness report and installs nothing while it lists something to change
        #[arg(long)]
        to: Option<String>,
        /// Only print the readiness report for --to (read-only; exits 1 when something must change)
        #[arg(long)]
        check: bool,
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
            no_toolbar,
        } => {
            let root = dunce::canonicalize(&dir)?;
            runtime::check(&root)?;
            load_dotenv_knobs(&root);
            let bind = listen::resolve(port, host)?;
            // Read by the dev renderer (server/render.mjs), which the sidecar runs with this
            // environment. Set here, before the runtime starts any other thread.
            if no_toolbar {
                std::env::set_var("NOWAKI_TOOLBAR", "0");
            }
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(dev::run(root, bind, open))
        }
        Command::Build { dir, adapter } => {
            let root = dunce::canonicalize(&dir)?;
            runtime::check(&root)?;
            load_dotenv_knobs(&root);
            // The static adapter hands off to prerender (build, a temporary server, then each
            // route rendered to a file).
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
            load_dotenv_knobs(&root);
            let bind = listen::resolve(port, host)?;
            // Rust (axum) serves static files and assembles HTML; the Node prod-sidecar renders.
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(start::run(root, bind))
        }
        Command::Prerender {
            dir,
            out,
            skip_build,
        } => {
            let root = dunce::canonicalize(&dir)?;
            runtime::check(&root)?;
            load_dotenv_knobs(&root);
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
        Command::Upgrade { dir, to, check } => {
            let root = dunce::canonicalize(&dir)?;
            upgrade::run(root, to, check)
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

/// The `NOWAKI_*` knobs `.env` / `.env.local` set that the environment doesn't: the Node half
/// (`server/env.mjs` `loadEnv`) reads them from those files, so the Rust half has to as well, or
/// e.g. a CSP mode in `.env` would turn on the nonces but not the header. Same precedence
/// (`nowaki_core::env::dotenv_values`). `NOWAKI_HOST` stays out, like `PORT`: the listen address
/// comes from the shell or the flags.
fn dotenv_knobs(root: &std::path::Path, is_set: impl Fn(&str) -> bool) -> Vec<(String, String)> {
    nowaki_core::env::dotenv_values(root, [])
        .into_iter()
        .filter(|(k, _)| k.starts_with("NOWAKI_") && k != "NOWAKI_HOST" && !is_set(k))
        .collect()
}

/// Applies [`dotenv_knobs`] to this process (and so to the sidecar it starts). Called before the
/// async runtime starts any other thread.
fn load_dotenv_knobs(root: &std::path::Path) {
    for (k, v) in dotenv_knobs(root, |k| std::env::var_os(k).is_some()) {
        std::env::set_var(k, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn entry(text: &str, help: &str) -> String {
        let help = help.split_whitespace().collect::<Vec<_>>().join(" ");
        if help.is_empty() {
            format!("{text}\n")
        } else {
            format!("{text}  # {help}\n")
        }
    }

    /// One argument as api/cli.txt lists it: flags (or `<NAME>` for a positional), value name,
    /// default and possible values.
    fn arg_line(a: &clap::Arg) -> String {
        let value_name = || {
            a.get_value_names()
                .and_then(|v| v.first().map(|n| n.to_string()))
                .unwrap_or_else(|| a.get_id().to_string().to_uppercase())
        };
        let mut line = if a.is_positional() {
            format!("<{}>", value_name())
        } else {
            let mut flags = Vec::new();
            if let Some(l) = a.get_long() {
                flags.push(format!("--{l}"));
            }
            if let Some(s) = a.get_short() {
                flags.push(format!("-{s}"));
            }
            let mut l = flags.join(" ");
            if a.get_action().takes_values() {
                l.push_str(&format!(" <{}>", value_name()));
            }
            l
        };
        let defaults: Vec<_> = a
            .get_default_values()
            .iter()
            .map(|v| v.to_string_lossy().into_owned())
            .collect();
        if !defaults.is_empty() {
            line.push_str(&format!(" default={}", defaults.join(",")));
        }
        let values: Vec<_> = a
            .get_possible_values()
            .iter()
            .filter(|v| !v.is_hide_set())
            .map(|v| v.get_name().to_string())
            .collect();
        if !values.is_empty() && a.get_action().takes_values() {
            line.push_str(&format!(" values={}", values.join("|")));
        }
        line
    }

    fn add_command(out: &mut String, path: &str, cmd: &clap::Command) {
        out.push_str(&format!("\n[stable {path}]\n"));
        let subs: Vec<_> = cmd.get_subcommands().collect();
        for s in &subs {
            let about = s.get_about().map(|a| a.to_string()).unwrap_or_default();
            out.push_str(&entry(&format!("command {}", s.get_name()), &about));
        }
        for a in cmd.get_arguments().filter(|a| !a.is_hide_set()) {
            let help = a.get_help().map(|h| h.to_string()).unwrap_or_default();
            out.push_str(&entry(&arg_line(a), &help));
        }
        // clap's own `help` subcommand mirrors the tree; listing it once is enough.
        for s in subs.into_iter().filter(|s| s.get_name() != "help") {
            add_command(out, &format!("{path} {}", s.get_name()), s);
        }
    }

    /// The CLI surface for api/cli.txt, from clap's own description of the commands (not the
    /// rendered help, so it doesn't depend on the terminal or the platform). Help text goes in
    /// the `#` comment after each entry, so rewording it updates the snapshot without changing a
    /// command, flag or value.
    fn cli_surface() -> String {
        let mut cmd = Cli::command();
        cmd.build();
        let mut out = String::from(
            "# nowaki CLI: commands, flags, value names, defaults and possible values, from clap\n\
             # (crates/nowaki/src/main.rs). Written by `NOWAKI_UPDATE_SNAPSHOTS=1 cargo test -p nowaki\n\
             # --bin nowaki cli_surface` (or `node scripts/api-surface.mjs`); `cargo test` fails when\n\
             # it is out of date. The comment after an entry is its help text. Not covered: the text\n\
             # of the build report and other output, and the `--version` string.\n",
        );
        add_command(&mut out, "nowaki", &cmd);
        out
    }

    #[test]
    fn cli_surface_matches_api_snapshot() {
        let api = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../api");
        if !api.is_dir() {
            return; // a packaged crate, outside the repository
        }
        let path = api.join("cli.txt");
        let got = cli_surface();
        if std::env::var_os("NOWAKI_UPDATE_SNAPSHOTS").is_some() {
            std::fs::write(&path, &got).unwrap();
            return;
        }
        let want = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            want == got,
            "api/cli.txt is out of date. Run `node scripts/api-surface.mjs` (or \
             NOWAKI_UPDATE_SNAPSHOTS=1 cargo test -p nowaki --bin nowaki cli_surface), review the \
             diff and commit it.\n--- generated ---\n{got}"
        );
    }

    #[test]
    fn dotenv_knobs_follow_the_dotenv_precedence() {
        let dir = std::env::temp_dir().join(format!("nowaki-knobs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".env"),
            "NOWAKI_LIVE_MAX=5\nNOWAKI_TRUST_PROXY=1\nNOWAKI_HOST=0.0.0.0\nPORT=1\nOTHER=x\n",
        )
        .unwrap();
        std::fs::write(dir.join(".env.local"), "NOWAKI_LIVE_MAX=9\n").unwrap();
        let got = dotenv_knobs(&dir, |k| k == "NOWAKI_TRUST_PROXY");
        assert_eq!(got, [("NOWAKI_LIVE_MAX".to_string(), "9".to_string())]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
