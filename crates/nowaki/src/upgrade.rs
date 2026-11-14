//! `nowaki upgrade`: updates an existing app's `nowaki` (CLI) and `@nowaki-dev/runtime` to the
//! latest version, or to the version or dist-tag given with `--to`.
//!
//! On 0.x a caret (`^0.x`) locks the minor, so `npm update` doesn't go from 0.10 to 0.11. The
//! command installs `<name>@<spec>` explicitly, which updates the range in package.json too.
//!
//! When `--to` names a version (0.20.0 or later) on a newer major (or 0.x minor) than the app,
//! the command first prints the readiness report ([`crate::readiness`]) and installs nothing
//! while the report lists something that must change. `--check` prints the report and never
//! installs.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::readiness::{self, Finding, Level};
use crate::runtime::Version;
use crate::ui;

const RUNTIME: &str = "@nowaki-dev/runtime";
const CLI: &str = "nowaki";

/// Runs `nowaki upgrade` in `root`. `to` is a version or dist-tag (default `latest`); `check`
/// only prints the readiness report.
pub fn run(root: PathBuf, to: Option<String>, check: bool) -> Result<()> {
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

    let spec = to.as_deref().unwrap_or("latest");
    let target = Version::parse(spec);
    if target.is_none() && !is_dist_tag(spec) {
        bail!("--to \"{spec}\" is neither a version (1.0.0, 1.0.0-rc.1) nor an npm dist-tag (latest, next).");
    }
    // npm wants the version without a leading `v`.
    let spec = target
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_else(|| spec.to_string());
    let spec = spec.as_str();

    let facts = readiness::Facts::read(&root, cur_runtime.as_deref());
    if check || needs_report(target.as_ref(), facts.current.as_ref()) {
        let found = readiness::scan(&root, &pkg, &facts);
        print_report(&root, spec, &facts, &found);
        let must = found.iter().filter(|f| f.level == Level::Must).count();
        if must > 0 {
            bail!(
                "{must} thing(s) to change before upgrading to {spec}; nothing was installed.\n  → Fix them, then run `nowaki upgrade --to {spec}` again (`--check` only re-checks)."
            );
        }
        if check {
            return Ok(());
        }
    }

    let pm = detect_pm(&root);

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
    if target.as_ref().is_some_and(Version::is_prerelease) {
        println!(
            "  {}",
            ui::dim(&format!("{spec} is a release candidate (npm dist-tag `next`); `nowaki upgrade` without --to goes back to latest"))
        );
    }
    println!();

    // The runtime goes in dependencies; the CLI stays where it was (devDependencies or
    // dependencies).
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

/// Whether the readiness report runs before installing: for a target version on a newer line
/// (major, or minor on 0.x) than the app's, from 0.20.0 (the release that removed the aliases
/// the report looks for) on. A dist-tag (`latest`, `next`) is not resolved here (no network), so
/// it gets the report only with `--check`.
fn needs_report(target: Option<&Version>, current: Option<&Version>) -> bool {
    let Some(target) = target else {
        return false;
    };
    let from = Version::parse("0.20.0-0").expect("a version");
    target >= &from && current.is_none_or(|c| c < target && c.line() != target.line())
}

/// An npm dist-tag: `latest`, `next`, `v1-lts`, … (not a range or a path).
fn is_dist_tag(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.starts_with(|c: char| c.is_ascii_alphabetic())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

fn print_report(root: &Path, spec: &str, facts: &readiness::Facts, found: &[Finding]) {
    println!(
        "{} {}",
        ui::bold(&format!("Readiness for {spec}")),
        ui::dim("(read-only: nothing is changed)")
    );
    println!("  {} {}", ui::dim("app       "), root.display());
    let current = match (&facts.runtime_installed, &facts.current) {
        (Some(v), _) => format!("{RUNTIME} {v} (installed)"),
        (None, Some(v)) => format!("{RUNTIME} {v} (package.json; not installed)"),
        _ => format!("{RUNTIME} not found"),
    };
    println!("  {} {current}", ui::dim("current   "));
    println!(
        "  {} nowaki {} (this CLI)",
        ui::dim("report by "),
        env!("CARGO_PKG_VERSION")
    );
    for (level, title) in [
        (Level::Must, "Must change"),
        (Level::Check, "Check (heuristics: review each)"),
    ] {
        let items: Vec<_> = found.iter().filter(|f| f.level == level).collect();
        if items.is_empty() {
            continue;
        }
        println!();
        let heading = format!("{title}: {}", items.len());
        println!(
            "  {}",
            if level == Level::Must {
                ui::red(&heading)
            } else {
                ui::bold(&heading)
            }
        );
        for f in items {
            println!("    {}  {}", ui::cyan(&f.location()), f.what);
            println!("      {}", ui::dim(&format!("→ {}", f.fix)));
        }
    }
    println!();
    if found.iter().all(|f| f.level != Level::Must) {
        println!("  {}", ui::green("✓ nothing must change"));
        println!();
    }
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

/// The package manager from the app's lockfile; npm without one.
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

/// Runs `<pm> add|install [dev flag] <spec>` with inherited stdio.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn the_report_runs_for_a_newer_major_from_0_20() {
        let yes = |t: &str, c: Option<&str>| needs_report(Some(&v(t)), c.map(v).as_ref());
        assert!(yes("1.0.0", Some("0.19.3")));
        assert!(yes("1.0.0", Some("0.20.1")));
        assert!(yes("1.0.0-rc.1", Some("0.20.0")));
        assert!(yes("0.20.0", Some("0.19.3")));
        assert!(yes("2.0.0", Some("1.4.0")));
        assert!(yes("1.0.0", None), "unknown current version");
        assert!(!yes("1.2.0", Some("1.0.0")), "same major");
        assert!(!yes("1.0.0", Some("1.0.0-rc.2")), "same major, from an rc");
        assert!(!yes("0.19.3", Some("0.18.0")), "before 0.20.0");
        assert!(!yes("0.20.0", Some("1.0.0")), "a downgrade");
        assert!(!needs_report(None, Some(&v("0.19.3"))), "a dist-tag");
    }

    #[test]
    fn dist_tags_and_versions_are_told_apart() {
        for ok in ["latest", "next", "v1-lts", "beta.1"] {
            assert!(is_dist_tag(ok), "{ok}");
        }
        for bad in ["", "^1.0.0", "../x", "1.0.0", "a b", "file:x"] {
            assert!(!is_dist_tag(bad), "{bad}");
        }
    }
}
