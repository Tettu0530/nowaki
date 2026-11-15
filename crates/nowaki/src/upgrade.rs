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

    let plan = Plan::new(&root, &pkg, to.as_deref())?;
    let spec = plan.spec.as_str();

    let mut facts = readiness::Facts::read(&root, plan.runtime_range());
    if check || needs_report(plan.target.as_ref(), facts.current.as_ref()) {
        facts.upgrade_to = plan.installs_both().then(|| spec.to_string());
        let found = readiness::scan(&root, &pkg, &facts);
        print_report(&root, spec, check, &facts, &found);
        let must = blocking(&found);
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
    for i in &plan.installs {
        println!(
            "  {} {}  {}",
            ui::dim(i.name),
            i.from.as_deref().unwrap_or("(not in package.json)"),
            ui::dim(&format!("→ {spec}"))
        );
    }
    if plan.target.as_ref().is_some_and(Version::is_prerelease) {
        println!(
            "  {}",
            ui::dim(&format!("{spec} is a release candidate (npm dist-tag `next`); `nowaki upgrade` without --to goes back to latest"))
        );
    }
    println!();

    for i in &plan.installs {
        run_pm(&root, &pm, i.dev, &format!("{}@{spec}", i.name))?;
    }

    if let Some(after) = std::fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    {
        println!("\n{}", ui::green("✓ updated"));
        for i in &plan.installs {
            if let Some((_, range)) = declared(&after, i.name, i.dev) {
                println!("  {} {}", ui::dim(i.name), range);
            }
        }
    }
    println!(
        "\n  {}",
        ui::dim("next: rebuild to verify — `nowaki build` (or `npm run build`)")
    );
    Ok(())
}

/// What `nowaki upgrade` installs: each package at `spec`.
#[derive(Debug)]
struct Plan {
    /// A version (without `v`) or a dist-tag.
    spec: String,
    /// `spec` as a version; `None` for a dist-tag.
    target: Option<Version>,
    installs: Vec<Install>,
}

/// One `<pm> add [-D] <name>@<spec>`.
#[derive(Debug, PartialEq, Eq)]
struct Install {
    name: &'static str,
    /// The package.json range before the upgrade; `None` when only node_modules has it.
    from: Option<String>,
    /// Installed into devDependencies (else dependencies).
    dev: bool,
}

impl Plan {
    /// Installs the runtime and the CLI at `to` (default `latest`) when package.json or
    /// node_modules has them, so both end up on the same version (before 0.19.3 they were
    /// released at different versions). Each stays in the section it is in; one only in
    /// node_modules goes where a new app has it (the runtime in dependencies, the CLI in
    /// devDependencies).
    fn new(root: &Path, pkg: &serde_json::Value, to: Option<&str>) -> Result<Plan> {
        let spec = to.unwrap_or("latest");
        let target = Version::parse(spec);
        if target.is_none() && !is_dist_tag(spec) {
            bail!("--to \"{spec}\" is neither a version (1.0.0, 1.0.0-rc.1) nor an npm dist-tag (latest, next).");
        }
        // npm wants the version without a leading `v`.
        let spec = target
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| spec.to_string());

        let mut installs = Vec::new();
        for (name, default_dev) in [(RUNTIME, false), (CLI, true)] {
            let install = match declared(pkg, name, default_dev) {
                Some((dev, range)) => Install {
                    name,
                    from: Some(range),
                    dev,
                },
                None if crate::runtime::installed_version(root, name)
                    .ok()
                    .flatten()
                    .is_some() =>
                {
                    Install {
                        name,
                        from: None,
                        dev: default_dev,
                    }
                }
                None => continue,
            };
            installs.push(install);
        }
        if installs.is_empty() {
            bail!("This doesn't look like a Nowaki app (neither {RUNTIME} nor {CLI} found in dependencies).");
        }
        Ok(Plan {
            spec,
            target,
            installs,
        })
    }

    /// Whether both packages are installed at `spec`, which resolves a version mismatch between
    /// them.
    fn installs_both(&self) -> bool {
        [RUNTIME, CLI]
            .iter()
            .all(|n| self.installs.iter().any(|i| i.name == *n))
    }

    /// The runtime's package.json range.
    fn runtime_range(&self) -> Option<&str> {
        self.installs
            .iter()
            .find(|i| i.name == RUNTIME)
            .and_then(|i| i.from.as_deref())
    }
}

/// `(in devDependencies, range)` for `name` in package.json, looking in devDependencies first
/// when `dev_first` (the CLI) and in dependencies first otherwise (the runtime).
fn declared(pkg: &serde_json::Value, name: &str, dev_first: bool) -> Option<(bool, String)> {
    let mut groups = [("dependencies", false), ("devDependencies", true)];
    if dev_first {
        groups.reverse();
    }
    groups.iter().find_map(|(group, dev)| {
        let range = pkg.get(group)?.get(name)?.as_str()?;
        Some((*dev, range.to_string()))
    })
}

/// The findings that stop the install: the "must change" ones. Those the install itself
/// resolves ([`Level::Upgrade`]) don't.
fn blocking(found: &[Finding]) -> usize {
    found.iter().filter(|f| f.level == Level::Must).count()
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

/// The report; `check` is `--check` (nothing gets installed), else the install follows it.
fn print_report(root: &Path, spec: &str, check: bool, facts: &readiness::Facts, found: &[Finding]) {
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
    if let Some(v) = &facts.cli_installed {
        println!("  {} {CLI} {v} (installed)", ui::dim("          "));
    }
    println!(
        "  {} nowaki {} (this CLI)",
        ui::dim("report by "),
        env!("CARGO_PKG_VERSION")
    );
    let fixed = if check {
        format!("Fixed by `nowaki upgrade --to {spec}` (nothing to change by hand)")
    } else {
        "Fixed by this upgrade (nothing to change by hand)".to_string()
    };
    for (level, title) in [
        (Level::Must, "Must change"),
        (Level::Upgrade, fixed.as_str()),
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

    /// An app from before 0.19.3: CLI 0.18.2 and runtime 0.17.2, declared and installed.
    fn old_app(pkg: &str, extra: &[(&str, &str)]) -> (tempfile::TempDir, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut files = vec![
            ("package.json", pkg),
            (
                "node_modules/nowaki/package.json",
                r#"{"name":"nowaki","version":"0.18.2"}"#,
            ),
            (
                "node_modules/@nowaki-dev/runtime/package.json",
                r#"{"name":"@nowaki-dev/runtime","version":"0.17.2"}"#,
            ),
        ];
        files.extend_from_slice(extra);
        for (rel, text) in files {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        let pkg = serde_json::from_str(pkg).unwrap();
        (dir, pkg)
    }

    const OLD_PKG: &str = r#"{
  "dependencies": { "@nowaki-dev/runtime": "^0.17.2" },
  "devDependencies": { "nowaki": "^0.18.2" }
}"#;

    /// What `run` does before installing, with the machine facts fixed: the plan, and the
    /// findings when the report runs.
    fn prepare(
        root: &Path,
        pkg: &serde_json::Value,
        to: &str,
        check: bool,
    ) -> (Plan, Option<Vec<Finding>>) {
        let plan = Plan::new(root, pkg, Some(to)).unwrap();
        let mut facts = readiness::Facts::read(root, plan.runtime_range());
        facts.node = Some("22.11.0".into());
        facts.rustc = Some("1.97.0".into());
        facts.port_env = None;
        let found =
            (check || needs_report(plan.target.as_ref(), facts.current.as_ref())).then(|| {
                facts.upgrade_to = plan.installs_both().then(|| plan.spec.clone());
                readiness::scan(root, pkg, &facts)
            });
        (plan, found)
    }

    #[test]
    fn an_app_from_before_0_19_3_upgrades_both_packages_without_a_blocker() {
        let (dir, pkg) = old_app(OLD_PKG, &[]);
        for (to, check) in [
            ("0.20.0", false),
            ("1.0.0-rc.1", false),
            ("v1.0.0-rc.1", false),
            ("next", true),
            ("0.20.0", true),
        ] {
            let (plan, found) = prepare(dir.path(), &pkg, to, check);
            let spec = to.trim_start_matches('v');
            assert_eq!(plan.spec, spec);
            assert_eq!(
                plan.installs,
                [
                    Install {
                        name: RUNTIME,
                        from: Some("^0.17.2".into()),
                        dev: false,
                    },
                    Install {
                        name: CLI,
                        from: Some("^0.18.2".into()),
                        dev: true,
                    },
                ],
                "{to}"
            );
            let found = found.unwrap_or_else(|| panic!("{to}: the report runs"));
            assert_eq!(blocking(&found), 0, "{to}: {found:#?}");
            let fixed: Vec<_> = found.iter().filter(|f| f.level == Level::Upgrade).collect();
            assert_eq!(fixed.len(), 1, "{to}: {found:#?}");
            assert!(
                fixed[0]
                    .what
                    .contains("nowaki 0.18.2 and @nowaki-dev/runtime 0.17.2 are installed"),
                "{:?}",
                fixed[0]
            );
            assert!(
                fixed[0].fix.contains(&format!("installs both at {spec}")),
                "{:?}",
                fixed[0]
            );
        }
        // `--to next` without --check: no report (a dist-tag isn't resolved), so nothing blocks.
        let (plan, found) = prepare(dir.path(), &pkg, "next", false);
        assert!(found.is_none());
        assert!(plan.installs_both());
    }

    #[test]
    fn code_changes_still_block_next_to_the_fixed_mismatch() {
        let (dir, pkg) = old_app(
            OLD_PKG,
            &[("routes/_error.tsx", "export default () => null;\n")],
        );
        let (_, found) = prepare(dir.path(), &pkg, "0.20.0", false);
        let found = found.unwrap();
        assert_eq!(blocking(&found), 1, "{found:#?}");
        assert_eq!(
            found.iter().filter(|f| f.level == Level::Upgrade).count(),
            1
        );
    }

    #[test]
    fn the_plan_keeps_each_package_in_its_section() {
        // The CLI in dependencies stays there.
        let (dir, pkg) = old_app(
            r#"{"dependencies":{"@nowaki-dev/runtime":"^0.17.2","nowaki":"^0.18.2"}}"#,
            &[],
        );
        let plan = Plan::new(dir.path(), &pkg, None).unwrap();
        assert_eq!(plan.spec, "latest");
        assert_eq!(
            plan.installs
                .iter()
                .map(|i| (i.name, i.dev))
                .collect::<Vec<_>>(),
            [(RUNTIME, false), (CLI, false)]
        );
        // Installed but not declared: still installed, so both end up on the target.
        let (dir, pkg) = old_app(r#"{"dependencies":{"@nowaki-dev/runtime":"^0.17.2"}}"#, &[]);
        let plan = Plan::new(dir.path(), &pkg, Some("0.20.0")).unwrap();
        assert_eq!(
            plan.installs
                .iter()
                .map(|i| (i.name, i.dev))
                .collect::<Vec<_>>(),
            [(RUNTIME, false), (CLI, true)]
        );
        assert!(plan.installs_both());
        // Only the runtime anywhere: a mismatch can't be fixed by installing one package, so it
        // stays "must change".
        let dir = tempfile::tempdir().unwrap();
        let pkg = serde_json::json!({"dependencies": {"@nowaki-dev/runtime": "^0.19.3"}});
        let plan = Plan::new(dir.path(), &pkg, Some("0.20.0")).unwrap();
        assert!(!plan.installs_both());
        assert!(Plan::new(dir.path(), &serde_json::json!({}), None).is_err());
        assert!(Plan::new(dir.path(), &pkg, Some("^1.0.0")).is_err());
    }
}
