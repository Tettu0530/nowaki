//! The installed `@nowaki-dev/runtime` against the oldest one this CLI works with. An older
//! runtime lacks scripts the CLI runs (the plugin host's config read, static-paths.mjs), so
//! `dev` / `build` / `start` / `prerender` stop with the fix instead of running without them.
//! One small file read (the runtime's package.json); no Node.

use std::path::Path;

use anyhow::{bail, Context, Result};

/// The oldest `@nowaki-dev/runtime` this CLI supports. Since 0.19.3 the CLI and the runtime are
/// released together under one version, so it is the CLI's own.
pub const MIN_RUNTIME: &str = env!("CARGO_PKG_VERSION");

/// Fails when the app's `@nowaki-dev/runtime` is older than [`MIN_RUNTIME`]. A missing runtime
/// passes: the command that needs it reports that itself.
pub fn check(root: &Path) -> Result<()> {
    let file = root.join("node_modules/@nowaki-dev/runtime/package.json");
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(());
    };
    let pkg: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("{} is invalid", file.display()))?;
    let installed = pkg["version"].as_str().unwrap_or("");
    check_version(installed, MIN_RUNTIME)
}

fn check_version(installed: &str, min: &str) -> Result<()> {
    let want = parse(min).expect("MIN_RUNTIME is a version");
    match parse(installed) {
        Some(have) if have >= want => Ok(()),
        _ => {
            bail!(
                "@nowaki-dev/runtime {installed} is too old for nowaki {cli}, which needs {min} or newer.\n  → Run `npm i @nowaki-dev/runtime@^{min}` (or pnpm / yarn / bun) in the app directory.",
                installed = if installed.is_empty() { "(no version)" } else { installed },
                cli = env!("CARGO_PKG_VERSION"),
            )
        }
    }
}

/// `major.minor.patch` and whether it is a release: a prerelease (`0.19.0-beta.1`) sorts before
/// its release, as in semver. Build metadata is ignored.
fn parse(v: &str) -> Option<(u64, u64, u64, bool)> {
    let v = v.split('+').next()?;
    let (core, pre) = match v.split_once('-') {
        Some((core, _)) => (core, true),
        None => (v, false),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??, !pre);
    parts.next().is_none().then_some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_like_semver() {
        assert!(check_version("0.17.1", "0.17.1").is_ok());
        assert!(check_version("0.17.2", "0.17.1").is_ok());
        assert!(check_version("0.18.0", "0.17.1").is_ok());
        assert!(check_version("1.0.0", "0.17.1").is_ok());
        assert!(check_version("0.19.0+build.5", "0.19.0").is_ok());
        assert!(check_version("0.17.0", "0.17.1").is_err());
        assert!(check_version("0.9.9", "0.17.1").is_err());
        assert!(check_version("0.19.0-beta.1", "0.19.0").is_err());
        assert!(check_version("0.19.1-beta.1", "0.19.0").is_ok());
        assert!(check_version("", "0.17.1").is_err());
        assert!(check_version("latest", "0.17.1").is_err());
        assert!(check_version("0.17", "0.17.1").is_err());
    }

    #[test]
    fn the_error_names_both_versions_and_the_fix() {
        let msg = format!("{:#}", check_version("0.16.3", "0.17.1").unwrap_err());
        assert!(
            msg.contains("@nowaki-dev/runtime 0.16.3 is too old"),
            "{msg}"
        );
        assert!(msg.contains("needs 0.17.1 or newer"), "{msg}");
        assert!(msg.contains(env!("CARGO_PKG_VERSION")), "{msg}");
        assert!(msg.contains("npm i @nowaki-dev/runtime@^0.17.1"), "{msg}");
    }

    #[test]
    fn a_missing_runtime_passes_and_an_installed_one_is_read() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check(dir.path()).is_ok(), "missing: the command reports it");
        let pkg = dir.path().join("node_modules/@nowaki-dev/runtime");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"version":"0.16.0"}"#).unwrap();
        assert!(check(dir.path()).is_err());
        std::fs::write(
            pkg.join("package.json"),
            format!(r#"{{"version":"{MIN_RUNTIME}"}}"#),
        )
        .unwrap();
        assert!(check(dir.path()).is_ok());
        // This repo's runtime is always supported.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/nowaki-runtime");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(repo.join("package.json")).unwrap())
                .unwrap();
        assert!(check_version(v["version"].as_str().unwrap(), MIN_RUNTIME).is_ok());
    }
}
