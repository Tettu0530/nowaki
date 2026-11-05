//! `site` from nowaki.config (the site's URL: canonical / Open Graph links, sitemap.xml,
//! robots.txt). The build writes it to `dist/server/site.json`, which the adapters and the edge
//! read; `NOWAKI_SITE` at runtime wins over it.

use std::path::Path;

use anyhow::{anyhow, Context, Result};

/// Writes `dist/server/site.json` when nowaki.config mentions `site` (no Node start otherwise).
pub fn write(root: &Path, dist: &Path) -> Result<()> {
    let out = dist.join("server/site.json");
    let _ = std::fs::remove_file(&out);
    let mentions_site = ["nowaki.config.mjs", "nowaki.config.js"]
        .iter()
        .filter_map(|n| std::fs::read_to_string(root.join(n)).ok())
        .any(|src| src.contains("site"));
    if !mentions_site {
        return Ok(());
    }
    let script = root.join("node_modules/@nowaki-dev/runtime/server/site-config.mjs");
    if !script.exists() {
        return Ok(()); // an older runtime: NOWAKI_SITE still works
    }
    let output = std::process::Command::new("node")
        .arg(&script)
        .current_dir(root)
        .output()
        .context("failed to run node for nowaki.config site")?;
    if !output.status.success() {
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        return Err(anyhow!("nowaki.config: `site` is invalid (see above)"));
    }
    let json = String::from_utf8_lossy(&output.stdout);
    if json.trim() != "{}" {
        std::fs::create_dir_all(dist.join("server"))?;
        std::fs::write(&out, json.as_bytes())?;
    }
    Ok(())
}
