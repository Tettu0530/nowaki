//! Per-route first-load client JS budgets (`export const budget` on route modules).
//!
//! Estimates gzip size the same way as production HTML: `runtime` + preloaded island
//! chunks (and `liveRuntime` when the route imports a live island). Lazy `routerRuntime`
//! is excluded (see `document.mjs` / `benchmarks/check-regression.mjs`).
//! Within-budget routes are silent unless `NOWAKI_BUDGET_VERBOSE=1`.
//! Only top-level static `import ... from "../islands/..."` lines are included.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use rayon::prelude::*;

use crate::routes::{
    is_api_route_rel, is_convention_source, stem_from_rel, url_pattern_from_stem, walk_routes_dir,
};
use crate::NowakiCore;

#[derive(Debug, Default)]
struct ClientManifest {
    runtime: Option<String>,
    router_runtime: Option<String>,
    live_runtime: Option<String>,
    islands: HashMap<String, String>,
    preload: HashMap<String, Vec<String>>,
}

#[derive(Debug, Default)]
pub(crate) struct BudgetOptions {
    pub strict: bool,
}

/// After `dist/client/` exists, check every route that declares `export const budget`.
pub(crate) fn check_route_budgets(
    core: &NowakiCore,
    dist: &Path,
    opts: &BudgetOptions,
) -> Result<()> {
    let client_dir = dist.join("client");
    let manifest_path = client_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Ok(());
    }
    let manifest = read_manifest(&manifest_path)?;
    let routes_dir = core.root.join("routes");
    if !routes_dir.is_dir() {
        return Ok(());
    }

    struct BudgetRoute {
        path: PathBuf,
        stem: String,
        limit: u64,
        source: String,
    }
    let mut budget_routes = Vec::new();
    for path in walk_routes_dir(&routes_dir)? {
        let rel = path
            .strip_prefix(&routes_dir)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        let Some(rel) = rel else { continue };
        let Some(stem) = stem_from_rel(&rel) else {
            continue;
        };
        let base = stem.rsplit('/').next().unwrap_or(&stem);
        if is_convention_source(base) || is_api_route_rel(&rel) {
            continue;
        }
        let source = core.read_source(&path)?;
        let Some(limit) = parse_gzip_budget(&source) else {
            continue;
        };
        budget_routes.push(BudgetRoute {
            path,
            stem,
            limit,
            source,
        });
    }
    if budget_routes.is_empty() {
        return Ok(());
    }

    let gzip_by_chunk = gzip_client_chunks(&client_dir)?;
    let router_lazy = lazy_router_chunks(&manifest);
    let log_ok = std::env::var("NOWAKI_BUDGET_VERBOSE")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
    let mut live_cache: HashMap<PathBuf, bool> = HashMap::new();
    let mut violations = 0usize;
    for route in budget_routes {
        let path = &route.path;
        let stem = &route.stem;
        let limit = route.limit;
        let source = &route.source;
        let url = url_pattern_from_stem(stem);
        let (client_islands, live) = island_imports(core, path, source, &mut live_cache)?;
        for name in &client_islands {
            if !manifest.islands.contains_key(name) {
                eprintln!(
                    "[nowaki] warning: route {url} imports island \"{name}\" but it is missing from the client manifest; the route budget estimate may be too low"
                );
            }
        }
        let bytes = first_load_gzip_bytes(
            &manifest,
            &gzip_by_chunk,
            &router_lazy,
            &client_islands,
            live,
        )?;
        if bytes <= limit {
            if log_ok {
                eprintln!(
                    "[nowaki] route budget: {url} first-load {} B gzip (limit {limit} B gzip) ok",
                    bytes
                );
            }
            continue;
        }
        violations += 1;
        let msg = format!(
            "route {url} first-load {bytes} B gzip exceeds budget {limit} B gzip ({})",
            path.strip_prefix(&core.root).unwrap_or(path).display()
        );
        if opts.strict {
            eprintln!("[nowaki] error: {msg}");
        } else {
            eprintln!("[nowaki] warning: {msg}. Re-run with --strict-budget to fail the build.");
        }
    }
    if opts.strict && violations > 0 {
        bail!("{violations} route budget(s) exceeded");
    }
    Ok(())
}

pub(crate) fn parse_gzip_budget(source: &str) -> Option<u64> {
    let tail = source.find("export const budget")?;
    let slice = &source[tail..];
    if let Some(n) = slice
        .strip_prefix("export const budget")
        .and_then(|s| s.trim_start().strip_prefix('='))
        .and_then(parse_budget_rhs)
    {
        return Some(n);
    }
    None
}

fn parse_budget_rhs(rhs: &str) -> Option<u64> {
    let rhs = rhs.trim_start();
    if rhs.starts_with('{') {
        let end = rhs.find('}')?;
        let inner = &rhs[1..end];
        for part in inner.split(',') {
            let part = part.trim();
            let (key, val) = part.split_once(':')?;
            if key.trim().eq_ignore_ascii_case("gzipjs") {
                return parse_u64_literal(val.trim());
            }
        }
        return None;
    }
    parse_u64_literal(rhs.split(';').next()?.trim())
}

fn parse_u64_literal(s: &str) -> Option<u64> {
    let s = s.trim_end_matches(';').trim().replace('_', "");
    s.parse().ok()
}

fn island_imports(
    core: &NowakiCore,
    route: &Path,
    source: &str,
    live_cache: &mut HashMap<PathBuf, bool>,
) -> Result<(Vec<String>, bool)> {
    let mut client = Vec::new();
    let mut live_on_page = false;
    for line in source.lines() {
        let line = line.trim();
        if !line.starts_with("import ") {
            continue;
        }
        let Some(from) = line.rsplit("from ").next() else {
            continue;
        };
        let spec = island_import_spec(from);
        let Some(spec) = spec else { continue };
        let Some(resolved) = core.resolve_spec(route.parent().unwrap_or(route), spec) else {
            continue;
        };
        let has_live = *live_cache.entry(resolved.clone()).or_insert_with(|| {
            core.read_source(&resolved)
                .ok()
                .is_some_and(|s| s.contains("export const live"))
        });
        if has_live {
            live_on_page = true;
            continue;
        }
        let name = resolved
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("island")
            .to_string();
        if !client.contains(&name) {
            client.push(name);
        }
    }
    Ok((client, live_on_page))
}

fn island_import_spec(from_clause: &str) -> Option<&str> {
    let spec = from_clause
        .trim()
        .trim_matches(';')
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    spec.contains("islands/").then_some(spec)
}

fn first_load_gzip_bytes(
    manifest: &ClientManifest,
    gzip_by_chunk: &HashMap<String, u64>,
    router_lazy: &HashSet<String>,
    island_names: &[String],
    live_on_page: bool,
) -> Result<u64> {
    let mut chunks = HashSet::new();
    if !island_names.is_empty() {
        if let Some(rt) = &manifest.runtime {
            add_preloaded(&mut chunks, rt, manifest);
        }
        for name in island_names {
            if let Some(file) = manifest.islands.get(name) {
                add_preloaded(&mut chunks, file, manifest);
            }
        }
    }
    if live_on_page {
        if let Some(lr) = &manifest.live_runtime {
            add_preloaded(&mut chunks, lr, manifest);
        }
    }
    chunks.retain(|f| !router_lazy.contains(f));

    let mut total = 0u64;
    for file in chunks {
        let Some(bytes) = gzip_by_chunk.get(&file) else {
            bail!("client chunk {file} missing under dist/client (manifest mismatch)");
        };
        total += bytes;
    }
    Ok(total)
}

fn lazy_router_chunks(manifest: &ClientManifest) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Some(r) = &manifest.router_runtime {
        add_preloaded(&mut out, r, manifest);
    }
    out
}

fn gzip_client_chunks(client_dir: &Path) -> Result<HashMap<String, u64>> {
    let names: Vec<String> = fs::read_dir(client_dir)
        .with_context(|| format!("read {}", client_dir.display()))?
        .filter_map(|e| {
            let e = e.ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".js") || !is_safe_chunk_name(&name) {
                return None;
            }
            Some(name)
        })
        .collect();
    names
        .into_par_iter()
        .map(|name| {
            let path = client_dir.join(&name);
            let raw = fs::read(&path)
                .with_context(|| format!("failed to read client chunk {}", path.display()))?;
            let gz = gzip_len(&raw)?;
            Ok((name, gz))
        })
        .collect::<Result<HashMap<_, _>>>()
}

fn is_safe_chunk_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

fn add_preloaded(out: &mut HashSet<String>, entry: &str, manifest: &ClientManifest) {
    let mut stack = vec![entry.to_string()];
    while let Some(f) = stack.pop() {
        if !out.insert(f.clone()) {
            continue;
        }
        if let Some(deps) = manifest.preload.get(&f) {
            for d in deps {
                stack.push(d.clone());
            }
        }
    }
}

fn gzip_len(raw: &[u8]) -> Result<u64> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(raw)?;
    Ok(enc.finish()?.len() as u64)
}

fn read_manifest(path: &Path) -> Result<ClientManifest> {
    let raw = fs::read_to_string(path)?;
    Ok(ClientManifest {
        runtime: json_string_or_null(&raw, "runtime"),
        router_runtime: json_string_or_null(&raw, "routerRuntime"),
        live_runtime: json_string_or_null(&raw, "liveRuntime"),
        islands: parse_string_map(&raw, "islands")?,
        preload: parse_preload_map(&raw)?,
    })
}

fn json_string_or_null(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let i = json.find(&needle)?;
    let rest = json[i + needle.len()..].trim_start();
    if rest.starts_with("null") {
        return None;
    }
    parse_json_string(rest)
}

fn parse_json_string(s: &str) -> Option<String> {
    let s = s.trim_start();
    if !s.starts_with('"') {
        return None;
    }
    let mut out = String::new();
    let mut esc = false;
    for c in s[1..].chars() {
        if esc {
            out.push(c);
            esc = false;
            continue;
        }
        if c == '\\' {
            esc = true;
            continue;
        }
        if c == '"' {
            return Some(out);
        }
        out.push(c);
    }
    None
}

fn parse_string_map(json: &str, key: &str) -> Result<HashMap<String, String>> {
    let block = extract_object(json, key).unwrap_or_default();
    let mut map = HashMap::new();
    for line in block.lines() {
        let line = line.trim().trim_end_matches(',');
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let k = parse_json_string(k.trim()).unwrap_or_default();
        let v = parse_json_string(v.trim()).unwrap_or_default();
        if !k.is_empty() && !v.is_empty() {
            map.insert(k, v);
        }
    }
    Ok(map)
}

fn parse_preload_map(json: &str) -> Result<HashMap<String, Vec<String>>> {
    let block = extract_object(json, "preload").unwrap_or_default();
    let mut map = HashMap::new();
    let mut lines = block.lines().peekable();
    while let Some(line) = lines.next() {
        let line = line.trim();
        if !line.contains(':') {
            continue;
        }
        let (k, rest) = line.split_once(':').unwrap();
        let key = parse_json_string(k.trim()).unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        if rest.trim().starts_with('[') {
            let mut arr = rest.trim().to_string();
            while !arr.contains(']') {
                if let Some(next) = lines.next() {
                    arr.push(' ');
                    arr.push_str(next.trim());
                } else {
                    break;
                }
            }
            let inner = arr.trim_start_matches('[').split(']').next().unwrap_or("");
            let vals: Vec<String> = inner
                .split(',')
                .filter_map(|p| parse_json_string(p.trim()))
                .collect();
            map.insert(key, vals);
        }
    }
    Ok(map)
}

fn extract_object(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start();
    if !rest.starts_with('{') {
        return None;
    }
    let mut depth = 0i32;
    let mut out = String::new();
    for ch in rest.chars() {
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                break;
            }
        }
        if depth >= 1 {
            out.push(ch);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_app(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("nowaki-budget-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for (rel, src) in files {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, src).unwrap();
        }
        root
    }

    #[test]
    fn parse_budget_literal_and_object() {
        assert_eq!(
            parse_gzip_budget("export const budget = 12000;\n"),
            Some(12000)
        );
        assert_eq!(
            parse_gzip_budget("export const budget = { gzipJs: 999 };\n"),
            Some(999)
        );
    }

    #[test]
    fn route_budget_warns_when_exceeded() {
        let root = dunce::canonicalize(temp_app(
            "over",
            &[
                (
                    "islands/Tiny.tsx",
                    "export default function Tiny() { return null; }\n",
                ),
                (
                    "routes/index.tsx",
                    "import Tiny from \"../islands/Tiny.tsx\";\nexport const budget = { gzipJs: 1 };\nexport default function Page() { return <Tiny />; }\n",
                ),
            ],
        ))
        .unwrap();
        let core = NowakiCore::new(root.clone());
        let dist = root.join("dist");
        crate::build::build_client(&core, &dist).expect("client build");
        let err = check_route_budgets(&core, &dist, &BudgetOptions { strict: true })
            .expect_err("should fail strict");
        assert!(err.to_string().contains("route budget"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn route_without_islands_within_budget() {
        let root = dunce::canonicalize(temp_app(
            "plain",
            &[
                (
                    "routes/about.tsx",
                    "export const budget = { gzipJs: 8192 };\nexport default function About() { return null; }\n",
                ),
            ],
        ))
        .unwrap();
        let core = NowakiCore::new(root.clone());
        let dist = root.join("dist");
        crate::build::build_client(&core, &dist).expect("client build");
        check_route_budgets(&core, &dist, &BudgetOptions { strict: true }).expect("ok");
        let _ = fs::remove_dir_all(&root);
    }
}
