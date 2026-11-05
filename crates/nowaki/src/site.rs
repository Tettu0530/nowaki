//! The build-time parts of nowaki.config, read through Node once (nowaki-core runs no JS):
//! `site` (the site's URL: canonical / Open Graph links, sitemap.xml, robots.txt; written to
//! `dist/server/site.json` for the adapters and the edge, `NOWAKI_SITE` winning at runtime) and
//! `fonts` (fonts.rs).

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

/// `{ site?, fonts? }` from nowaki.config. Starts Node only when the config mentions either.
pub fn config(root: &Path) -> Result<Value> {
    let mentions = ["nowaki.config.mjs", "nowaki.config.js"]
        .iter()
        .filter_map(|n| std::fs::read_to_string(root.join(n)).ok())
        .any(|src| src.contains("site") || src.contains("fonts"));
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
        return Err(anyhow!(
            "nowaki.config: `site` or `fonts` is invalid (see above)"
        ));
    }
    serde_json::from_slice(&output.stdout).context("site-config.mjs printed invalid JSON")
}

/// Writes `dist/server/site.json` from `config` (removed when there is no site).
pub fn write(dist: &Path, config: &Value) -> Result<()> {
    let out = dist.join("server/site.json");
    let _ = std::fs::remove_file(&out);
    if let Some(site) = config.get("site").and_then(Value::as_str) {
        std::fs::create_dir_all(dist.join("server"))?;
        std::fs::write(&out, serde_json::json!({ "site": site }).to_string())?;
    }
    Ok(())
}
