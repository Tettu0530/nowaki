use std::collections::BTreeMap;
use std::path::Path;

/// Reads `.env` / `.env.local` and builds constant-replacement pairs safe to expose to the client.
/// - Only `PUBLIC_`-prefixed variables are exposed, as `import.meta.env.PUBLIC_X` (secrets never are)
/// - Also adds `import.meta.env.MODE` / `DEV` / `PROD`
///
/// Returns `(key, JS literal)` pairs for ReplaceGlobalDefines.
pub fn load_client_defines(root: &Path) -> Vec<(String, String)> {
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    for file in [".env", ".env.local"] {
        let Ok(content) = std::fs::read_to_string(root.join(file)) else {
            continue;
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some(eq) = line.find('=') else { continue };
            let key = line[..eq].trim().to_string();
            let mut val = line[eq + 1..].trim().to_string();
            let quoted = (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''));
            if quoted && val.len() >= 2 {
                val = val[1..val.len() - 1].to_string();
            }
            vars.insert(key, val);
        }
    }

    let mode = std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string());
    let is_prod = mode == "production";

    let mut defines = Vec::new();
    for (k, v) in &vars {
        if k.starts_with("PUBLIC_") {
            // {:?} escapes into a JS/JSON-compatible string literal
            defines.push((format!("import.meta.env.{k}"), format!("{v:?}")));
        }
    }
    defines.push(("import.meta.env.MODE".to_string(), format!("{mode:?}")));
    defines.push(("import.meta.env.DEV".to_string(), (!is_prod).to_string()));
    defines.push(("import.meta.env.PROD".to_string(), is_prod.to_string()));
    // React-ecosystem libraries branch on this; left as-is it throws `process is not defined`.
    defines.push(("process.env.NODE_ENV".to_string(), format!("{mode:?}")));
    set_base_url(&mut defines, "");
    defines
}

const BASE_URL: &str = "import.meta.env.BASE_URL";
/// The same value for the runtime's classic-script client files (client/live.js), which can't
/// name `import.meta`.
const RUNTIME_BASE_URL: &str = "__NOWAKI_BASE_URL__";

/// Sets `import.meta.env.BASE_URL` to `<base>/` (`base` is a checked basePath, `""` at the root).
pub(crate) fn set_base_url(defines: &mut Vec<(String, String)>, base: &str) {
    defines.retain(|(k, _)| k != BASE_URL && k != RUNTIME_BASE_URL);
    let value = format!("{:?}", format!("{base}/"));
    defines.push((RUNTIME_BASE_URL.to_string(), value.clone()));
    defines.push((BASE_URL.to_string(), value));
}

/// The value of `import.meta.env.BASE_URL` in `defines` (`/` when unset).
pub(crate) fn base_url(defines: &[(String, String)]) -> String {
    defines
        .iter()
        .find(|(k, _)| k == BASE_URL)
        .and_then(|(_, v)| serde_json::from_str::<String>(v).ok())
        .unwrap_or_else(|| "/".to_string())
}

/// The app's environment schema: `env.ts` (or `.mts` / `.js` / `.mjs`) at the root, if any.
pub fn env_file(root: &Path) -> Option<std::path::PathBuf> {
    ["env.ts", "env.mts", "env.js", "env.mjs"]
        .into_iter()
        .map(|f| root.join(f))
        .find(|p| p.is_file())
}

/// Replaces the `import.meta.env.PUBLIC_*` pairs in `defines` with `vars`, the public values an
/// app's `env.ts` validated (`(name, literal)`: a JSON string / number / boolean / null, or
/// `undefined`). Names must be `PUBLIC_` + letters, digits, `_`.
pub(crate) fn replace_public_defines(
    defines: &mut Vec<(String, String)>,
    vars: &[(String, String)],
) -> anyhow::Result<()> {
    let mut next = Vec::with_capacity(vars.len());
    for (name, literal) in vars {
        let valid_name = name.len() > "PUBLIC_".len()
            && name.starts_with("PUBLIC_")
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !valid_name {
            anyhow::bail!(
                "public env name {name:?} must be PUBLIC_ followed by letters, digits, or _"
            );
        }
        let scalar = literal == "undefined"
            || matches!(
                serde_json::from_str::<serde_json::Value>(literal),
                Ok(serde_json::Value::String(_)
                    | serde_json::Value::Number(_)
                    | serde_json::Value::Bool(_)
                    | serde_json::Value::Null)
            );
        if !scalar {
            anyhow::bail!(
                "public env {name}: the value must be a JSON string, number, boolean, or null"
            );
        }
        next.push((format!("import.meta.env.{name}"), literal.clone()));
    }
    defines.retain(|(k, _)| !k.starts_with("import.meta.env.PUBLIC_"));
    defines.extend(next);
    Ok(())
}

/// The inlined `import.meta.env.PUBLIC_*` values as a JSON object (`undefined` ones left out),
/// written to `dist/server/env-public.json`: the server's `env` uses the values the client got.
pub(crate) fn public_values_json(defines: &[(String, String)]) -> String {
    let map: serde_json::Map<String, serde_json::Value> = defines
        .iter()
        .filter_map(|(k, v)| {
            let name = k.strip_prefix("import.meta.env.")?;
            if !name.starts_with("PUBLIC_") {
                return None;
            }
            Some((name.to_string(), serde_json::from_str(v).ok()?))
        })
        .collect();
    serde_json::Value::Object(map).to_string()
}

/// Whether `abs` is `@nowaki-dev/runtime/env/server` (`server/env-server.mjs` of the runtime
/// package): server-only, so client code must never import it.
pub fn is_server_env_module(abs: &Path) -> bool {
    if abs.file_name().is_none_or(|n| n != "env-server.mjs") {
        return false;
    }
    let Some(server) = abs.parent() else {
        return false;
    };
    if server.file_name().is_none_or(|n| n != "server") {
        return false;
    }
    let Some(pkg) = server.parent() else {
        return false;
    };
    std::fs::read_to_string(pkg.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v["name"] == "@nowaki-dev/runtime")
}

/// The error for client code that imports `@nowaki-dev/runtime/env/server`, naming the import
/// chain (`islands/A.tsx → lib/config.ts → @nowaki-dev/runtime/env/server`).
pub fn server_env_import_error(root: &Path, chain: &[std::path::PathBuf]) -> String {
    let names: Vec<String> = chain
        .iter()
        .map(|p| {
            if is_server_env_module(p) {
                "@nowaki-dev/runtime/env/server".to_string()
            } else {
                p.strip_prefix(root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .replace('\\', "/")
            }
        })
        .collect();
    format!(
        "@nowaki-dev/runtime/env/server is server-only, but client code imports it: {}. Read server variables in a loader, action, or server function and pass the values down, or declare them as PUBLIC_* in env.ts (import.meta.env).",
        names.join(" → ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_defines_replace_dotenv_ones() {
        let mut d = vec![
            (
                "import.meta.env.PUBLIC_OLD".to_string(),
                "\"x\"".to_string(),
            ),
            (
                "import.meta.env.MODE".to_string(),
                "\"production\"".to_string(),
            ),
        ];
        replace_public_defines(
            &mut d,
            &[
                ("PUBLIC_API".into(), "\"/api\"".into()),
                ("PUBLIC_N".into(), "3".into()),
                ("PUBLIC_U".into(), "undefined".into()),
            ],
        )
        .unwrap();
        let keys: Vec<&str> = d.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            [
                "import.meta.env.MODE",
                "import.meta.env.PUBLIC_API",
                "import.meta.env.PUBLIC_N",
                "import.meta.env.PUBLIC_U"
            ]
        );
    }

    #[test]
    fn public_values_json_skips_undefined_and_non_public() {
        let d = vec![
            (
                "import.meta.env.PUBLIC_A".to_string(),
                "\"/api\"".to_string(),
            ),
            ("import.meta.env.PUBLIC_N".to_string(), "3".to_string()),
            (
                "import.meta.env.PUBLIC_U".to_string(),
                "undefined".to_string(),
            ),
            (
                "import.meta.env.MODE".to_string(),
                "\"production\"".to_string(),
            ),
        ];
        assert_eq!(
            public_values_json(&d),
            r#"{"PUBLIC_A":"/api","PUBLIC_N":3}"#
        );
    }

    #[test]
    fn public_defines_reject_bad_names_and_code() {
        let mut d = Vec::new();
        for (k, v) in [
            ("SECRET", "\"x\""),
            ("PUBLIC_", "\"x\""),
            ("PUBLIC_A.b", "\"x\""),
            ("PUBLIC_A", "alert(1)"),
            ("PUBLIC_A", "{\"a\":1}"),
            ("PUBLIC_A", "[1]"),
        ] {
            assert!(
                replace_public_defines(&mut d, &[(k.into(), v.into())]).is_err(),
                "{k}={v}"
            );
        }
        assert!(d.is_empty());
    }

    #[test]
    fn server_env_module_needs_the_runtime_package() {
        let dir = std::env::temp_dir().join(format!("nowaki-env-guard-{}", std::process::id()));
        let file = dir.join("server/env-server.mjs");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "").unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"other"}"#).unwrap();
        assert!(!is_server_env_module(&file));
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"@nowaki-dev/runtime"}"#,
        )
        .unwrap();
        assert!(is_server_env_module(&file));
        assert!(!is_server_env_module(&dir.join("server/env.mjs")));
        let msg = server_env_import_error(&dir, &[dir.join("islands/A.tsx"), file.clone()]);
        assert!(
            msg.contains("islands/A.tsx → @nowaki-dev/runtime/env/server"),
            "{msg}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
