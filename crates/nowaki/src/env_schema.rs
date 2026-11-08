//! Typed environment (`env.ts`): before a build (and at `nowaki dev` startup) the runtime's
//! env-check.mjs validates the environment against the app's schemas in Node, and the validated
//! public values replace the `.env` ones the client build inlines. Apps without env.ts skip it.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use nowaki_core::NowakiCore;

/// Validates the environment against env.ts and gives the core its public values. Fails, listing
/// every problem, on a missing or invalid variable. Does nothing without env.ts.
pub fn check(root: &Path, core: &mut NowakiCore) -> Result<()> {
    let Some(file) = nowaki_core::env::env_file(root) else {
        return Ok(());
    };
    let script = root.join("node_modules/@nowaki-dev/runtime/server/env-check.mjs");
    if !script.exists() {
        return Err(anyhow!(
            "env.ts needs @nowaki-dev/runtime 0.18 or newer (server/env-check.mjs not found)"
        ));
    }
    let out = std::process::Command::new("node")
        .arg(&script)
        .arg(&file)
        .current_dir(root)
        .output()
        .context("failed to run node for the env.ts check")?;
    if !out.status.success() {
        eprint!("{}", String::from_utf8_lossy(&out.stderr));
        return Err(anyhow!(
            "environment variables don't match env.ts (listed above)"
        ));
    }
    let vars = parse_ok(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| anyhow!("env.ts check printed no result"))?;
    core.set_public_env(&vars)?;
    println!("[nowaki] env: env.ts checked ({} public)", vars.len());
    Ok(())
}

/// The `NOWAKI_ENV_OK [[name, literal], ...]` line (env.ts may log other lines first).
fn parse_ok(stdout: &str) -> Option<Vec<(String, String)>> {
    let json = stdout
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("NOWAKI_ENV_OK "))?;
    serde_json::from_str(json).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_ok_reads_the_last_result_line() {
        let out = "env.ts says hi\nNOWAKI_ENV_OK [[\"PUBLIC_A\",\"\\\"/api\\\"\"],[\"PUBLIC_B\",\"undefined\"]]\n";
        assert_eq!(
            super::parse_ok(out).unwrap(),
            vec![
                ("PUBLIC_A".to_string(), "\"/api\"".to_string()),
                ("PUBLIC_B".to_string(), "undefined".to_string())
            ]
        );
        assert!(super::parse_ok("nothing\n").is_none());
    }
}
