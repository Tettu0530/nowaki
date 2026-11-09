//! Typed environment (`env.ts`): before a build (and at `nowaki dev` startup) the runtime's
//! env-check.mjs validates the environment against the app's schemas in Node, and the validated
//! public values replace the `.env` ones the client build inlines. Apps without env.ts skip it.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use nowaki_core::NowakiCore;

/// A running env.ts check (see [`start`]); `None` when the app has no env.ts.
pub struct Pending(Option<std::process::Child>);

/// Starts the env.ts check in Node without waiting for it, so it runs while the config is read,
/// the plugin host starts and the core is set up (it costs a Node start plus the schema library's
/// import, ~80 ms, which would otherwise come before every build and dev start). Pass the result
/// to [`finish`] before building.
pub fn start(root: &Path) -> Result<Pending> {
    let Some(file) = nowaki_core::env::env_file(root) else {
        return Ok(Pending(None));
    };
    let script = root.join("node_modules/@nowaki-dev/runtime/server/env-check.mjs");
    if !script.exists() {
        return Err(anyhow!(
            "env.ts needs @nowaki-dev/runtime 0.18 or newer (server/env-check.mjs not found)"
        ));
    }
    let child = std::process::Command::new("node")
        .arg(&script)
        .arg(&file)
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("failed to run node for the env.ts check")?;
    Ok(Pending(Some(child)))
}

/// Waits for the check and gives the core its public values. Fails, listing every problem, on a
/// missing or invalid variable. Does nothing without env.ts.
pub fn finish(pending: Pending, core: &mut NowakiCore) -> Result<()> {
    let Some(child) = pending.0 else {
        return Ok(());
    };
    let out = child
        .wait_with_output()
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
