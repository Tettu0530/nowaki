//! `nowaki upgrade`: update an existing app's nowaki (CLI) and @nowaki-dev/runtime to the latest version.
//!
//! On 0.x a caret (`^0.x`) locks the minor, so `npm update` won't go from 0.10 → 0.11.
//! Install `@latest` (or `--to`) explicitly to update the range in package.json too.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::ui;

const RUNTIME: &str = "@nowaki-dev/runtime";
const CLI: &str = "nowaki";

pub fn run(root: PathBuf, to: Option<String>) -> Result<()> {
    let pkg_path = root.join("package.json");
    if !pkg_path.exists() {
        bail!(
            "package.json not found ({}). Run this in a Nowaki app directory.",
            root.display()
        );
    }
    let text = std::fs::read_to_string(&pkg_path)
        .with_context(|| format!("failed to read: {}", pkg_path.display()))?;
    let pkg: serde_json::Value =
        serde_json::from_str(&text).context("failed to parse package.json")?;

    let dep = |group: &str, name: &str| -> Option<String> {
        pkg.get(group)?.get(name)?.as_str().map(str::to_string)
    };
    let cur_runtime = dep("dependencies", RUNTIME);
    let cur_cli = dep("devDependencies", CLI).or_else(|| dep("dependencies", CLI));
    let cli_is_dev = dep("devDependencies", CLI).is_some();

    if cur_runtime.is_none() && cur_cli.is_none() {
        bail!("This doesn't look like a Nowaki app (neither {RUNTIME} nor {CLI} found in dependencies).");
    }

    let pm = detect_pm(&root);
    let spec = to.as_deref().unwrap_or("latest");

    println!("{}", ui::bold("Nowaki upgrade"));
    println!("  {} {}", ui::dim("package manager"), pm.name());
    if let Some(v) = &cur_runtime {
        println!(
            "  {} {}  {}",
            ui::dim(RUNTIME),
            v,
            ui::dim(&format!("→ {spec}"))
        );
    }
    if let Some(v) = &cur_cli {
        println!(
            "  {} {}  {}",
            ui::dim(CLI),
            v,
            ui::dim(&format!("→ {spec}"))
        );
    }
    println!();

    // runtime goes in dependencies, CLI in devDependencies (matching where it was).
    if cur_runtime.is_some() {
        run_pm(&root, &pm, false, &format!("{RUNTIME}@{spec}"))?;
    }
    if cur_cli.is_some() {
        run_pm(&root, &pm, cli_is_dev, &format!("{CLI}@{spec}"))?;
    }

    if let Some(after) = std::fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    {
        let show = |group: &str, name: &str| {
            if let Some(v) = after
                .get(group)
                .and_then(|g| g.get(name))
                .and_then(|v| v.as_str())
            {
                println!("  {} {}", ui::dim(name), v);
            }
        };
        println!("\n{}", ui::green("✓ updated"));
        show("dependencies", RUNTIME);
        show("devDependencies", CLI);
        show("dependencies", CLI);
    }
    println!(
        "\n  {}",
        ui::dim("next: rebuild to verify — `nowaki build` (or `npm run build`)")
    );
    Ok(())
}

enum Pm {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl Pm {
    fn name(&self) -> &'static str {
        match self {
            Pm::Npm => "npm",
            Pm::Pnpm => "pnpm",
            Pm::Yarn => "yarn",
            Pm::Bun => "bun",
        }
    }
}

fn detect_pm(root: &Path) -> Pm {
    if root.join("pnpm-lock.yaml").exists() {
        Pm::Pnpm
    } else if root.join("yarn.lock").exists() {
        Pm::Yarn
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        Pm::Bun
    } else {
        Pm::Npm
    }
}

/// Run `<pm> add/install [dev-flag] <spec>` (stdio is inherited and shown as-is).
fn run_pm(root: &Path, pm: &Pm, dev: bool, spec: &str) -> Result<()> {
    let (prog, verb, dev_flag) = match pm {
        Pm::Npm => ("npm", "install", "-D"),
        Pm::Pnpm => ("pnpm", "add", "-D"),
        Pm::Yarn => ("yarn", "add", "-D"),
        Pm::Bun => ("bun", "add", "-d"),
    };
    let mut args = vec![verb.to_string()];
    if dev {
        args.push(dev_flag.to_string());
    }
    args.push(spec.to_string());

    println!("{} {} {}", ui::cyan("$"), prog, args.join(" "));
    let status = Command::new(prog)
        .args(&args)
        .current_dir(root)
        .status()
        .with_context(|| format!("failed to start {prog} (is it installed?)"))?;
    if !status.success() {
        bail!("{prog} {spec} failed");
    }
    Ok(())
}
