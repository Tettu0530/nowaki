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
    defines
}
