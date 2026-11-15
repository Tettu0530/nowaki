//! Deploy adapters: turn the build output `dist/` into a deployable artifact for each target.
//!
//! node / bun / deno output runs on `@nowaki-dev/runtime`'s `server/app.mjs` alone, without the
//! nowaki binary; its `package.json` lists the runtime packages plus every npm package the server
//! code imports (`dist/server/server-deps.json`, written by the server build). `main.rs` hands
//! `static` to prerender.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::ValueEnum;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum Adapter {
    /// Self-contained Node server (default)
    #[default]
    Node,
    /// Static site (SSG, prerender)
    Static,
    /// Bun runtime (same node:http-compatible entry)
    Bun,
    /// Deno runtime (same node:http-compatible entry)
    Deno,
    /// Cloudflare Workers (Edge, fetch handler + static assets binding)
    Cloudflare,
    /// Vercel (Build Output API v3, Node serverless function + static assets)
    Vercel,
}

impl Adapter {
    fn label(self) -> &'static str {
        match self {
            Adapter::Node => "node",
            Adapter::Static => "static",
            Adapter::Bun => "bun",
            Adapter::Deno => "deno",
            Adapter::Cloudflare => "cloudflare",
            Adapter::Vercel => "vercel",
        }
    }

    /// Command that serves the build, run from inside `dist/server/`.
    fn run_cmd(self) -> &'static str {
        match self {
            Adapter::Bun => "bun index.mjs",
            Adapter::Deno => "deno run -A index.mjs",
            _ => "node index.mjs",
        }
    }
}

/// Writes the server-entry adapters' (node/bun/deno) artifact to `dist/server/`.
pub fn emit_server(root: &Path, dist: &Path, adapter: Adapter) -> Result<()> {
    let server_dir = dist.join("server");
    std::fs::create_dir_all(&server_dir)
        .with_context(|| format!("failed to create dist/server: {}", server_dir.display()))?;

    // runtime::check accepted the installed runtime; without one, the version this CLI needs.
    let runtime_ver = installed_version(root, "@nowaki-dev/runtime")
        .unwrap_or_else(|| crate::runtime::MIN_RUNTIME.into());
    let preact_ver = installed_version(root, "preact").unwrap_or_else(|| "10.25.0".into());
    let prts_ver =
        installed_version(root, "preact-render-to-string").unwrap_or_else(|| "6.5.0".into());

    let index = format!(
        r#"// nowaki deploy entry ({label} adapter, generated).
// `{run}` in this directory serves production. No nowaki binary needed.
// Deps: the runtime packages and the app's server packages (package.json in this dir).
import path from "node:path";
import {{ fileURLToPath }} from "node:url";
import {{ startServer }} from "@nowaki-dev/runtime/server/app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/server
await startServer({{
  clientDir: path.join(here, "../client"),
  serverDir: here,
  port: Number(process.env.PORT ?? 3000),
}});
"#,
        label = adapter.label(),
        run = adapter.run_cmd(),
    );
    std::fs::write(server_dir.join("index.mjs"), index)?;

    // package.json for `npm install` at deploy time: the runtime packages, plus the packages the
    // app's server code imports.
    let mut deps = serde_json::Map::new();
    deps.insert(
        "@nowaki-dev/runtime".into(),
        format!("^{runtime_ver}").into(),
    );
    deps.insert("preact".into(), format!("^{preact_ver}").into());
    deps.insert(
        "preact-render-to-string".into(),
        format!("^{prts_ver}").into(),
    );
    let app_deps = server_deps(root, &server_dir)?;
    for (name, spec) in &app_deps {
        deps.insert(name.clone(), spec.clone().into());
    }
    let pkg = serde_json::json!({
        "name": "nowaki-app-server",
        "private": true,
        "type": "module",
        "scripts": { "start": adapter.run_cmd() },
        "dependencies": deps,
    });
    let pkg = serde_json::to_string_pretty(&pkg)? + "\n";
    std::fs::write(server_dir.join("package.json"), pkg)?;
    if !app_deps.is_empty() {
        let names: Vec<&str> = app_deps.keys().map(String::as_str).collect();
        println!(
            "[nowaki] {} adapter: dist/server/package.json lists the packages the server imports: {}",
            adapter.label(),
            names.join(", ")
        );
    }

    println!(
        "[nowaki] {} adapter: wrote dist/server/index.mjs. Deploy: `cd dist/server && npm install --omit=dev && {}`",
        adapter.label(),
        adapter.run_cmd()
    );
    Ok(())
}

/// Generates `dist/worker/`. The work is done by the runtime's `server/edge-build.mjs`.
pub fn emit_cloudflare(root: &Path, dist: &Path) -> Result<()> {
    let script = crate::runtime::script(root, "edge-build.mjs", "the cloudflare adapter")?;
    let app_name = read_json_field(&root.join("package.json"), "name")
        .map(|n| sanitize_worker_name(&n))
        .unwrap_or_else(|| "nowaki-app".into());
    let status = std::process::Command::new("node")
        .arg(&script)
        .arg(dist.join("server"))
        .arg(dist.join("client"))
        .arg(dist.join("worker"))
        .arg(&app_name)
        .current_dir(root)
        .status()
        .context("failed to start node edge-build.mjs")?;
    if !status.success() {
        anyhow::bail!("cloudflare adapter generation failed");
    }
    println!(
        "[nowaki] cloudflare adapter: wrote dist/worker. Test: `cd dist/worker && npx wrangler dev` / Deploy: `cd dist/worker && npx wrangler deploy`"
    );
    Ok(())
}

/// Generates `.vercel/output/`. The work is done by the runtime's `server/vercel-build.mjs`.
pub fn emit_vercel(root: &Path, dist: &Path) -> Result<()> {
    let script = crate::runtime::script(root, "vercel-build.mjs", "the vercel adapter")?;
    let output = root.join(".vercel/output");
    let status = std::process::Command::new("node")
        .arg(&script)
        .arg(dist.join("server"))
        .arg(dist.join("client"))
        .arg(&output)
        .arg(root)
        .current_dir(root)
        .status()
        .context("failed to start node vercel-build.mjs")?;
    if !status.success() {
        anyhow::bail!("vercel adapter generation failed");
    }
    println!(
        "[nowaki] vercel adapter: wrote .vercel/output. Deploy: `npx vercel deploy --prebuilt` (or `vercel --prebuilt`)"
    );
    Ok(())
}

/// The runtime packages every server artifact gets anyway.
const RUNTIME_PACKAGES: [&str; 3] = ["@nowaki-dev/runtime", "preact", "preact-render-to-string"];

/// The app's server packages for `dist/server/package.json`: name → dependency spec, for every
/// package in `server-deps.json` but the runtime ones.
///
/// - A package installed from the registry gets its installed version, exactly (what the build
///   ran against; there is no lockfile next to dist/server).
/// - A remote spec in the app's package.json (`npm:` alias, git, a URL) is kept as written.
/// - A local package (`file:` / `link:`, or installed outside any node_modules and not declared)
///   is copied to `dist/server/vendor/` and listed as `file:./vendor/...`, so the install works
///   wherever dist/ goes. A `workspace:` package is listed by its version (as `pnpm publish`
///   would), so it has to be published.
///
/// A package that isn't installed is left out with a warning (the server would fail to import it).
fn server_deps(root: &Path, server_dir: &Path) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    // Absent for a dist/server that no server build wrote: nothing to add.
    let Ok(text) = std::fs::read_to_string(server_dir.join("server-deps.json")) else {
        return Ok(out);
    };
    let names: Vec<String> =
        serde_json::from_str(&text).context("dist/server/server-deps.json is not valid")?;
    let declared = declared_deps(root);
    for name in names {
        if RUNTIME_PACKAGES.contains(&name.as_str()) {
            continue;
        }
        let spec = declared.get(&name).map(String::as_str);
        if let Some(rel) = spec.and_then(|s| s.strip_prefix("file:").or(s.strip_prefix("link:"))) {
            let spec = vendor(&root.join(rel), server_dir, &name)?;
            out.insert(name, spec);
            continue;
        }
        if let Some(s) = spec.filter(|s| is_remote_spec(s)) {
            out.insert(name, s.to_string());
            continue;
        }
        let Some(dir) = find_package(root, &name) else {
            eprintln!(
                "[nowaki] warning: the server imports `{name}`, which isn't installed; dist/server/package.json leaves it out"
            );
            continue;
        };
        let real = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if spec.is_none() && !real.components().any(|c| c.as_os_str() == "node_modules") {
            let spec = vendor(&real, server_dir, &name)?;
            out.insert(name, spec);
            continue;
        }
        match read_json_field(&dir.join("package.json"), "version") {
            Some(v) => {
                out.insert(name, v);
            }
            None => eprintln!(
                "[nowaki] warning: `{name}` has no version in its package.json; dist/server/package.json leaves it out"
            ),
        }
    }
    Ok(out)
}

/// The app's declared dependencies, all four kinds (`dependencies` wins): name → spec.
fn declared_deps(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(root.join("package.json")) else {
        return out;
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    for field in [
        "peerDependencies",
        "devDependencies",
        "optionalDependencies",
        "dependencies",
    ] {
        if let Some(map) = pkg.get(field).and_then(|v| v.as_object()) {
            for (name, spec) in map {
                if let Some(spec) = spec.as_str() {
                    out.insert(name.clone(), spec.to_string());
                }
            }
        }
    }
    out
}

/// A dependency spec that installs the same from anywhere: an `npm:` alias, git, or a URL.
fn is_remote_spec(spec: &str) -> bool {
    [
        "npm:",
        "git+",
        "git:",
        "github:",
        "gitlab:",
        "bitbucket:",
        "http:",
        "https:",
    ]
    .iter()
    .any(|p| spec.starts_with(p))
}

/// Copies the local package at `src` (a directory, without its node_modules, or a tarball) into
/// `dist/server/vendor/` and returns the `file:` spec for it.
fn vendor(src: &Path, server_dir: &Path, name: &str) -> Result<String> {
    let vendor_dir = server_dir.join("vendor");
    if src.is_file() {
        let file = src
            .file_name()
            .with_context(|| format!("{name}: not a package: {}", src.display()))?;
        std::fs::create_dir_all(&vendor_dir)?;
        std::fs::copy(src, vendor_dir.join(file))
            .with_context(|| format!("failed to copy {name} from {}", src.display()))?;
        return Ok(format!("file:./vendor/{}", file.to_string_lossy()));
    }
    copy_package_dir(src, &vendor_dir.join(name))
        .with_context(|| format!("failed to copy {name} from {}", src.display()))?;
    Ok(format!("file:./vendor/{name}"))
}

/// Copies a package directory without its node_modules and .git (symlinks are followed).
fn copy_package_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == "node_modules" || name == ".git" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if std::fs::metadata(&from)?.is_dir() {
            copy_package_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Node's lookup of a package from the app: `node_modules/<name>` in `root` or any parent.
fn find_package(root: &Path, name: &str) -> Option<PathBuf> {
    root.ancestors()
        .map(|dir| dir.join("node_modules").join(name))
        .find(|dir| dir.join("package.json").is_file())
}

/// Worker names allow only lowercase alphanumerics and hyphens.
fn sanitize_worker_name(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "nowaki-app".into()
    } else {
        trimmed
    }
}

/// The version installed in the app's `node_modules` (for the `^x.y.z` range).
fn installed_version(root: &Path, pkg: &str) -> Option<String> {
    read_json_field(
        &root.join("node_modules").join(pkg).join("package.json"),
        "version",
    )
}

/// The top-level string `field` of a package.json, if the file parses and has one.
fn read_json_field(pj: &Path, field: &str) -> Option<String> {
    let text = std::fs::read_to_string(pj).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get(field)?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_package_json_is_json_with_the_installed_versions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A nested "version" before the top-level one: read the top level.
        let rt = root.join("node_modules/@nowaki-dev/runtime");
        std::fs::create_dir_all(&rt).unwrap();
        std::fs::write(
            rt.join("package.json"),
            r#"{"engines":{"version":"x"},"version":"1.2.3-rc.\"1\""}"#,
        )
        .unwrap();
        let dist = root.join("dist");
        emit_server(root, &dist, Adapter::Node).unwrap();
        let text = std::fs::read_to_string(dist.join("server/package.json")).unwrap();
        let pkg: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(
            pkg["dependencies"]["@nowaki-dev/runtime"],
            "^1.2.3-rc.\"1\""
        );
        assert_eq!(pkg["scripts"]["start"], "node index.mjs");

        // No runtime installed: the version this CLI needs.
        std::fs::remove_dir_all(&rt).unwrap();
        emit_server(root, &dist, Adapter::Node).unwrap();
        let text = std::fs::read_to_string(dist.join("server/package.json")).unwrap();
        let pkg: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            pkg["dependencies"]["@nowaki-dev/runtime"],
            format!("^{}", crate::runtime::MIN_RUNTIME)
        );
    }

    #[test]
    fn server_package_json_lists_the_packages_the_server_imports() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let write = |rel: &str, text: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        write(
            "package.json",
            r#"{"dependencies":{"zod":"^4.0.0","greet":"file:./packages/greet","alias":"npm:other@1.2.3","unused":"^1.0.0"}}"#,
        );
        write("node_modules/zod/package.json", r#"{"version":"4.6.7"}"#);
        write("node_modules/unused/package.json", r#"{"version":"1.0.0"}"#);
        write(
            "packages/greet/package.json",
            r#"{"name":"greet","version":"0.1.0"}"#,
        );
        write("packages/greet/index.js", "export const greet = 1;\n");
        write(
            "packages/greet/node_modules/dep/package.json",
            r#"{"version":"1.0.0"}"#,
        );
        write(
            "dist/server/server-deps.json",
            r#"["@nowaki-dev/runtime","alias","greet","missing","preact","zod"]"#,
        );
        let dist = root.join("dist");
        emit_server(root, &dist, Adapter::Node).unwrap();
        let text = std::fs::read_to_string(dist.join("server/package.json")).unwrap();
        let pkg: serde_json::Value = serde_json::from_str(&text).unwrap();
        let deps = pkg["dependencies"].as_object().unwrap();
        // Registry: the installed version, exactly. Remote: as declared. Local: vendored.
        assert_eq!(deps["zod"], "4.6.7");
        assert_eq!(deps["alias"], "npm:other@1.2.3");
        assert_eq!(deps["greet"], "file:./vendor/greet");
        assert!(dist.join("server/vendor/greet/index.js").is_file());
        assert!(!dist.join("server/vendor/greet/node_modules").exists());
        // Not imported by the server, or not installed: not listed.
        assert!(!deps.contains_key("unused"));
        assert!(!deps.contains_key("missing"));
        // The runtime packages keep their caret range.
        assert!(deps["preact"].as_str().unwrap().starts_with('^'));
        assert_eq!(deps.len(), 6, "{deps:?}");
    }
}
