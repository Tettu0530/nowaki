//! The installed `@nowaki-dev/runtime` against the CLI. The CLI and the runtime are released
//! together under one version, and the CLI runs scripts from the runtime (the plugin host's
//! config read, static-paths.mjs, the renderers), so `dev` / `build` / `start` / `prerender` stop
//! with the fix when the runtime is older than the CLI or of another major, instead of running
//! against scripts that don't match. One small file read (the runtime's package.json); no Node.

use std::cmp::Ordering;
use std::path::Path;

use anyhow::{bail, Context, Result};

/// The oldest `@nowaki-dev/runtime` this CLI supports. Since 0.19.3 the CLI and the runtime are
/// released together under one version, so it is the CLI's own.
pub const MIN_RUNTIME: &str = env!("CARGO_PKG_VERSION");

/// Fails when the app's `@nowaki-dev/runtime` is older than [`MIN_RUNTIME`] or of another major
/// (a 0.x minor counts as a major). A missing runtime passes: the command that needs it reports
/// that itself.
pub fn check(root: &Path) -> Result<()> {
    let Some(installed) = installed_version(root, "@nowaki-dev/runtime")? else {
        return Ok(());
    };
    check_version(&installed, MIN_RUNTIME)
}

/// The `version` of `node_modules/<name>/package.json` under `root`, if it is installed.
pub fn installed_version(root: &Path, name: &str) -> Result<Option<String>> {
    let file = root.join("node_modules").join(name).join("package.json");
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(None);
    };
    let pkg: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("{} is invalid", file.display()))?;
    Ok(Some(pkg["version"].as_str().unwrap_or("").to_string()))
}

fn check_version(installed: &str, min: &str) -> Result<()> {
    let want = Version::parse(min).expect("MIN_RUNTIME is a version");
    let cli = env!("CARGO_PKG_VERSION");
    let Some(have) = Version::parse(installed) else {
        bail!(
            "@nowaki-dev/runtime has version \"{installed}\", which nowaki {cli} cannot read as a version; it needs {min} or newer on the same major.\n  → Run `npm i @nowaki-dev/runtime@^{min}` (or pnpm / yarn / bun) in the app directory.",
        );
    };
    if have < want {
        bail!(
            "@nowaki-dev/runtime {installed} is too old for nowaki {cli}, which needs {min} or newer.\n  → Run `npm i @nowaki-dev/runtime@^{min}` (or pnpm / yarn / bun) in the app directory.",
        );
    }
    if have.line() != want.line() {
        bail!(
            "@nowaki-dev/runtime {installed} is a newer major than nowaki {cli} (on 0.x, each minor is a major). Use the same version of both.\n  → Run `npm i -D nowaki@{installed}` to update the CLI, or `npm i @nowaki-dev/runtime@^{min}` to go back (or pnpm / yarn / bun), in the app directory.",
        );
    }
    Ok(())
}

/// A SemVer version: `major.minor.patch`, optional prerelease identifiers, build metadata
/// ignored. Ordered as SemVer orders it: a prerelease sorts before its release, identifiers are
/// compared left to right, numeric ones numerically and below alphanumeric ones, and a shorter
/// list sorts first when the rest is equal (`1.0.0-rc.1` < `1.0.0-rc.2` < `1.0.0-rc.10` <
/// `1.0.0`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<Ident>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ident {
    Num(u64),
    Alpha(String),
}

impl Version {
    pub fn parse(v: &str) -> Option<Version> {
        let v = v.trim();
        let v = v.strip_prefix('v').unwrap_or(v);
        let v = v.split('+').next()?;
        let (core, pre) = match v.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (v, None),
        };
        let num = |p: &str| -> Option<u64> {
            // SemVer: no leading zeros, digits only.
            (!p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p == "0" || !p.starts_with('0')))
            .then(|| p.parse().ok())
            .flatten()
        };
        let mut parts = core.split('.');
        let (major, minor, patch) = (
            num(parts.next()?)?,
            num(parts.next()?)?,
            num(parts.next()?)?,
        );
        if parts.next().is_some() {
            return None;
        }
        let mut ids = Vec::new();
        if let Some(pre) = pre {
            for id in pre.split('.') {
                if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                    return None;
                }
                ids.push(if id.bytes().all(|b| b.is_ascii_digit()) {
                    Ident::Num(num(id)?)
                } else {
                    Ident::Alpha(id.to_string())
                });
            }
        }
        Some(Version {
            major,
            minor,
            patch,
            pre: ids,
        })
    }

    /// The compatibility line: the major, or `0.minor` on 0.x (where a minor may break).
    pub fn line(&self) -> (u64, u64) {
        if self.major > 0 {
            (self.major, 0)
        } else {
            (0, self.minor)
        }
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Ident {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Ident::Num(a), Ident::Num(b)) => a.cmp(b),
            (Ident::Num(_), Ident::Alpha(_)) => Ordering::Less,
            (Ident::Alpha(_), Ident::Num(_)) => Ordering::Greater,
            (Ident::Alpha(a), Ident::Alpha(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Ident {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        for (i, id) in self.pre.iter().enumerate() {
            f.write_str(if i == 0 { "-" } else { "." })?;
            match id {
                Ident::Num(n) => write!(f, "{n}")?,
                Ident::Alpha(s) => f.write_str(s)?,
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("{s} parses"))
    }

    #[test]
    fn versions_compare_like_semver() {
        assert!(check_version("0.17.1", "0.17.1").is_ok());
        assert!(check_version("0.17.2", "0.17.1").is_ok());
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
    fn a_runtime_of_another_major_is_refused() {
        // Newer majors (a 0.x minor is a major).
        assert!(check_version("0.18.0", "0.17.1").is_err());
        assert!(check_version("1.0.0", "0.20.0").is_err());
        assert!(check_version("2.0.0", "1.4.0").is_err());
        assert!(check_version("2.0.0-rc.1", "1.4.0").is_err());
        // Same major, newer: fine.
        assert!(check_version("1.5.2", "1.4.0").is_ok());
        assert!(check_version("1.0.0", "1.0.0-rc.2").is_ok());
        // Older: refused, also within a prerelease series.
        assert!(check_version("1.3.9", "1.4.0").is_err());
        assert!(check_version("1.0.0-rc.1", "1.0.0-rc.2").is_err());
        assert!(check_version("1.0.0-rc.2", "1.0.0").is_err());
        assert!(check_version("0.20.0", "1.0.0-rc.1").is_err());
    }

    #[test]
    fn prerelease_identifiers_are_ordered() {
        let order = [
            "0.20.0",
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0-rc.2",
            "1.0.0-rc.10",
            "1.0.0",
            "1.0.1",
            "1.1.0",
        ];
        for pair in order.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
        assert_eq!(v("1.0.0+build.1"), v("1.0.0"));
        assert_eq!(v("v1.2.3"), v("1.2.3"));
        assert_eq!(v("1.0.0-rc.1").to_string(), "1.0.0-rc.1");
        assert!(v("1.0.0-rc.1").is_prerelease());
        assert_eq!(v("0.19.3").line(), (0, 19));
        assert_eq!(v("1.7.0").line(), (1, 0));
        for bad in [
            "1.0",
            "1.0.0.0",
            "01.0.0",
            "1.0.0-",
            "1.0.0-rc..1",
            "1.0.0-rc.01",
            "x.y.z",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad} is not a version");
        }
    }

    #[test]
    fn the_errors_name_both_versions_and_the_fix() {
        let cli = env!("CARGO_PKG_VERSION");
        let msg = format!("{:#}", check_version("0.16.3", "0.17.1").unwrap_err());
        assert!(
            msg.contains("@nowaki-dev/runtime 0.16.3 is too old"),
            "{msg}"
        );
        assert!(msg.contains("needs 0.17.1 or newer"), "{msg}");
        assert!(msg.contains(cli), "{msg}");
        assert!(msg.contains("npm i @nowaki-dev/runtime@^0.17.1"), "{msg}");

        let msg = format!("{:#}", check_version("2.0.0", "1.4.0").unwrap_err());
        assert!(
            msg.contains("@nowaki-dev/runtime 2.0.0 is a newer major than nowaki"),
            "{msg}"
        );
        assert!(msg.contains(cli), "{msg}");
        assert!(msg.contains("npm i -D nowaki@2.0.0"), "{msg}");
        assert!(msg.contains("npm i @nowaki-dev/runtime@^1.4.0"), "{msg}");

        let msg = format!("{:#}", check_version("latest", "1.4.0").unwrap_err());
        assert!(msg.contains("\"latest\""), "{msg}");
        assert!(msg.contains("npm i @nowaki-dev/runtime@^1.4.0"), "{msg}");
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
