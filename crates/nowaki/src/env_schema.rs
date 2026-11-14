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
    let script = crate::runtime::script(root, "env-check.mjs", "env.ts")?;
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

/// Validates env.ts on `--skip-build` and checks that the `PUBLIC_*` values match
/// `dist/server/env-public.json` from the prior build (what the client bundle inlined).
pub fn finish_skip_build(pending: Pending, root: &Path) -> Result<()> {
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
    let public: Vec<_> = vars
        .iter()
        .filter(|(n, _)| n.starts_with("PUBLIC_"))
        .collect();
    let built_path = root.join("dist/server/env-public.json");
    if built_path.is_file() {
        let built: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&built_path)?)?;
        for (name, literal) in &public {
            let current: serde_json::Value = serde_json::from_str(literal)
                .with_context(|| format!("public env {name}: invalid JSON from env.ts"))?;
            match built.get(name.as_str()) {
                Some(b) if b == &current => {}
                Some(b) => {
                    return Err(anyhow!(
                        "public env {name} ({current}) doesn't match the build ({b}). \
                         The client still carries the values from `nowaki build`; rebuild or align your environment."
                    ));
                }
                None => {
                    return Err(anyhow!(
                        "public env {name} isn't in dist/server/env-public.json; run `nowaki build` again."
                    ));
                }
            }
        }
        for key in built.keys() {
            if !public.iter().any(|(n, _)| n == key) {
                return Err(anyhow!(
                    "public env {key} from the build is missing in the current environment"
                ));
            }
        }
    } else if nowaki_core::env::env_file(root).is_some() {
        return Err(anyhow!(
            "dist/server/env-public.json is missing (incomplete build). Run `nowaki build` first."
        ));
    }
    println!(
        "[nowaki] env: env.ts checked ({} public, matches the build)",
        public.len()
    );
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
