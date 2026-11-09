//! The build-time parts of nowaki.config, read through Node once (nowaki-core runs no JS):
//! `site` (the site's URL: canonical / Open Graph links, sitemap.xml, robots.txt; written to
//! `dist/server/site.json` for the adapters and the edge, `NOWAKI_SITE` winning at runtime),
//! `fonts` (fonts.rs), `routing` (basePath, trailingSlash, redirects, rewrites, headers, i18n:
//! normalized and validated by site-config.mjs, written to `dist/server/routing.json`; dev:
//! `.nowaki/routing.json`) and `images` (remote image patterns). Read before the build, so an
//! invalid config fails before anything is built.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

/// Config keys that need Node to read; a config naming none of them skips it.
const KEYS: &[&str] = &[
    "site",
    "fonts",
    "basePath",
    "trailingSlash",
    "redirects",
    "rewrites",
    "headers",
    "i18n",
    "images",
];

/// `{ site?, fonts?, routing?, images? }` from nowaki.config. Starts Node only when the config
/// mentions one of them.
pub fn config(root: &Path) -> Result<Value> {
    let mentions = ["nowaki.config.mjs", "nowaki.config.js"]
        .iter()
        .filter_map(|n| std::fs::read_to_string(root.join(n)).ok())
        .any(|src| KEYS.iter().any(|k| src.contains(k)));
    if !mentions {
        return Ok(Value::Object(Default::default()));
    }
    let script = root.join("node_modules/@nowaki-dev/runtime/server/site-config.mjs");
    if !script.exists() {
        return Ok(Value::Object(Default::default())); // an older runtime: NOWAKI_SITE still works
    }
    let output = std::process::Command::new("node")
        .arg(&script)
        .current_dir(root)
        .output()
        .context("failed to run node for nowaki.config")?;
    if !output.status.success() {
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        return Err(anyhow!("nowaki.config is invalid (see above)"));
    }
    serde_json::from_slice(&output.stdout).context("site-config.mjs printed invalid JSON")
}

/// nowaki.config `basePath` from `config` (`""` without one).
pub fn base_path(config: &Value) -> &str {
    config
        .pointer("/routing/basePath")
        .and_then(Value::as_str)
        .unwrap_or("")
}

static ASSET_BASE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Gives `core` the config's basePath (asset URLs, the server function endpoint,
/// `import.meta.env.BASE_URL`) and remembers its asset prefix for content entries and fonts.
pub fn configure(core: &mut nowaki_core::NowakiCore, config: &Value) -> Result<()> {
    core.set_base_path(base_path(config))
        .map_err(|e| anyhow!("nowaki.config: {e}"))?;
    let _ = ASSET_BASE.set(core.asset_base());
    Ok(())
}

/// The URL prefix of built assets (`/_nowaki/`, or `<basePath>/_nowaki/`) `configure` set.
pub fn asset_base() -> &'static str {
    ASSET_BASE.get().map_or("/_nowaki/", String::as_str)
}

/// Writes `dist/server/site.json` and `dist/server/routing.json` from `config` (each removed
/// when the config has nothing for it).
pub fn write(dist: &Path, config: &Value) -> Result<()> {
    let out = dist.join("server/site.json");
    let _ = std::fs::remove_file(&out);
    if let Some(site) = config.get("site").and_then(Value::as_str) {
        std::fs::create_dir_all(dist.join("server"))?;
        std::fs::write(&out, serde_json::json!({ "site": site }).to_string())?;
    }
    write_routing(&dist.join("server/routing.json"), config)
}

/// `nowaki dev`: `.nowaki/routing.json`.
pub fn write_dev(root: &Path, config: &Value) -> Result<()> {
    write_routing(&root.join(".nowaki/routing.json"), config)
}

/// The routing config, also checked by the Rust compiler the fronts use. No file when there is
/// none, so a server without one does no per-request work.
fn write_routing(out: &Path, config: &Value) -> Result<()> {
    let _ = std::fs::remove_file(out);
    let Some(routing) = config.get("routing") else {
        return Ok(());
    };
    let parsed: nowaki_core::rules::RoutingConfig = serde_json::from_value(routing.clone())
        .context("nowaki.config: unexpected routing config from site-config.mjs")?;
    nowaki_core::rules::Rules::compile(&parsed).map_err(|e| anyhow!("nowaki.config: {e}"))?;
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(out, routing.to_string())?;
    Ok(())
}
