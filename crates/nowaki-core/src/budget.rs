//! First-load client JS per page route, and `export const budget = { js: <KB> }` checks.
//!
//! "First load" is what production HTML references for a page (`document.mjs` / `start.rs`
//! `assemble`): the islands runtime and the chunks it preloads when the page has a client island,
//! each island's chunk and its preloads, and the live runtime when the page has a live island. The
//! lazy SPA router chunk is not counted. Sizes are gzip (level 9), in KiB.
//!
//! Islands are found through the import graph, from the route and every `_layout` above it,
//! including islands imported through components. That can count an island the page renders only
//! sometimes, so the estimate errs high, which is the safe side for a budget.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::{
    BindingPattern, Declaration, Expression, ObjectPropertyKind, PropertyKey, Statement,
};

use crate::build::ClientInfo;
use crate::routes::{is_convention_source, is_endpoint_rel, stem_from_rel, url_pattern_from_stem};
use crate::NowakiCore;

#[derive(Debug, Clone)]
pub struct RouteJs {
    /// URL pattern, e.g. `/blog/[slug]`.
    pub url: String,
    /// Route file relative to the app root (POSIX separators).
    pub file: String,
    /// gzip bytes of every first-load chunk.
    pub gzip_bytes: u64,
    /// `export const budget = { js: … }`, in KiB.
    pub budget_kb: Option<f64>,
    /// Client islands the page can render (sorted).
    pub islands: Vec<String>,
    /// The page can render a live island (ships the live runtime).
    pub live: bool,
    /// The first-load chunk files under `dist/client` (sorted).
    pub chunks: Vec<String>,
}

impl RouteJs {
    pub fn kb(&self) -> f64 {
        self.gzip_bytes as f64 / 1024.0
    }
    pub fn over_budget(&self) -> bool {
        self.budget_kb.is_some_and(|b| self.kb() > b)
    }
}

/// Every page route (API routes and convention files excluded), in URL order.
pub fn route_first_load(
    core: &NowakiCore,
    client: &ClientInfo,
    client_dir: &Path,
) -> Result<Vec<RouteJs>> {
    let routes_dir = core.root.join("routes");
    let islands_dir = core.root.join("islands");
    let live: HashSet<&str> = client.live_islands.iter().map(String::as_str).collect();
    let mut gzip_cache: HashMap<String, u64> = HashMap::new();
    let mut gzip_of = |file: &str| -> u64 {
        *gzip_cache.entry(file.to_string()).or_insert_with(|| {
            fs::read(client_dir.join(file))
                .map(|b| crate::compress::gzip(&b, 9).len() as u64)
                .unwrap_or(0)
        })
    };

    // Page scripts come from the manifest the build just wrote (`routeScripts` per route or layout
    // module, `scriptPreload` per script), so ClientInfo stays as it is.
    let manifest: serde_json::Value = fs::read(client_dir.join("manifest.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let scripts_of = |key: &str| -> Vec<String> {
        let mut v = Vec::new();
        for f in manifest["routeScripts"][key]
            .as_array()
            .into_iter()
            .flatten()
        {
            let Some(f) = f.as_str() else { continue };
            v.push(f.to_string());
            for d in manifest["scriptPreload"][f]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(d) = d.as_str() {
                    v.push(d.to_string());
                }
            }
        }
        v
    };

    let mut out = Vec::new();
    for path in crate::routes::walk_routes_dir(&routes_dir)? {
        let Some(rel) = path
            .strip_prefix(&routes_dir)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
        else {
            continue;
        };
        let Some(stem) = stem_from_rel(&rel) else {
            continue;
        };
        let base = stem.rsplit('/').next().unwrap_or(&stem);
        if is_convention_source(base) || is_endpoint_rel(&rel) {
            continue;
        }

        let mut reach: HashSet<PathBuf> = crate::chunk::collect_app_modules(core, &path);
        for layout in layouts_for(&routes_dir, &rel) {
            reach.extend(crate::chunk::collect_app_modules(core, &layout));
        }
        let mut client_islands = BTreeSet::new();
        let mut has_live = false;
        for m in &reach {
            if m.parent() != Some(islands_dir.as_path()) {
                continue;
            }
            let Some(name) = m.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if live.contains(name) {
                has_live = true;
            } else if client.islands.contains_key(name) {
                client_islands.insert(name.to_string());
            }
        }

        let source = core.read_source(&path)?;
        let mut chunks: BTreeSet<String> = BTreeSet::new();
        // A streaming page sends its shell before it knows which islands render, so the shell
        // always loads the islands runtime (document.mjs prodShell), islands or not.
        if client_islands.is_empty() && is_streaming(&path, &source) {
            if let Some(rt) = &client.runtime {
                add_with_preloads(&mut chunks, rt, client);
            }
        }
        if !client_islands.is_empty() {
            if let Some(rt) = &client.runtime {
                add_with_preloads(&mut chunks, rt, client);
            }
            for name in &client_islands {
                if let Some(f) = client.islands.get(name) {
                    add_with_preloads(&mut chunks, f, client);
                }
            }
        }
        if has_live {
            if let Some(lr) = &client.live_runtime {
                chunks.insert(lr.clone());
            }
        }
        let mut modules: Vec<String> = layouts_for(&routes_dir, &rel)
            .iter()
            .filter_map(|l| l.strip_prefix(&routes_dir).ok())
            .filter_map(|l| stem_from_rel(&l.to_string_lossy().replace('\\', "/")))
            .collect();
        modules.push(stem.clone());
        for m in modules {
            chunks.extend(scripts_of(&format!("routes/{m}.js")));
        }
        let gzip_bytes = chunks.iter().map(|c| gzip_of(c)).sum();

        let budget_kb =
            parse_budget(&path, &source).map_err(|e| anyhow::anyhow!("routes/{rel}: {e}"))?;
        out.push(RouteJs {
            url: url_pattern_from_stem(&stem),
            file: format!("routes/{rel}"),
            gzip_bytes,
            budget_kb,
            islands: client_islands.into_iter().collect(),
            live: has_live,
            chunks: chunks.into_iter().collect(),
        });
    }
    out.sort_by(|a, b| a.url.cmp(&b.url));
    Ok(out)
}

fn add_with_preloads(chunks: &mut BTreeSet<String>, chunk: &str, client: &ClientInfo) {
    chunks.insert(chunk.to_string());
    for dep in client.preload.get(chunk).into_iter().flatten() {
        chunks.insert(dep.clone());
    }
}

/// `_layout.*` files that wrap `rel`: one per directory from `routes/` down to the route's own.
pub fn layouts_for(routes_dir: &Path, rel: &str) -> Vec<PathBuf> {
    let mut dirs = vec![routes_dir.to_path_buf()];
    let mut dir = routes_dir.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        dir = dir.join(part);
        dirs.push(dir.clone());
    }
    let mut out = Vec::new();
    for d in dirs {
        let Ok(entries) = fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            let is_layout = p
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.rsplit_once('.'))
                .is_some_and(|(stem, _)| stem == "_layout");
            if is_layout && crate::is_transformable(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// `export const streaming = true` or `"early"` (anything else renders the whole page first).
fn is_streaming(path: &Path, source: &str) -> bool {
    if !source.contains("streaming") {
        return false;
    }
    let allocator = Allocator::default();
    let source_type = crate::transform::source_type_for_path(path);
    let Ok(program) = crate::transform::parse_program(&allocator, path, source, source_type) else {
        return false;
    };
    program.body.iter().any(|stmt| {
        let Statement::ExportNamedDeclaration(d) = stmt else {
            return false;
        };
        let Some(Declaration::VariableDeclaration(var)) = &d.declaration else {
            return false;
        };
        var.declarations.iter().any(|decl| {
            let named =
                matches!(&decl.id, BindingPattern::BindingIdentifier(id) if id.name == "streaming");
            named
                && match decl.init.as_ref().map(unwrap_ts) {
                    Some(Expression::BooleanLiteral(b)) => b.value,
                    Some(Expression::StringLiteral(s)) => s.value == "early",
                    _ => false,
                }
        })
    })
}

/// Reads `export const budget = { js: <KiB> }` from the route's AST. None when there is no such
/// export; an error when there is one we can't read, so a typo never silently disables a budget.
pub fn parse_budget(path: &Path, source: &str) -> Result<Option<f64>> {
    if !source.contains("budget") {
        return Ok(None);
    }
    let allocator = Allocator::default();
    let source_type = crate::transform::source_type_for_path(path);
    let program = crate::transform::parse_program(&allocator, path, source, source_type)?;
    for stmt in &program.body {
        let Statement::ExportNamedDeclaration(d) = stmt else {
            continue;
        };
        let Some(Declaration::VariableDeclaration(var)) = &d.declaration else {
            continue;
        };
        for decl in &var.declarations {
            let BindingPattern::BindingIdentifier(id) = &decl.id else {
                continue;
            };
            if id.name != "budget" {
                continue;
            }
            let Some(init) = decl.init.as_ref().map(unwrap_ts) else {
                bail!("`export const budget` needs a value: {{ js: <KB of gzip JS> }}");
            };
            let Expression::ObjectExpression(obj) = init else {
                bail!("`export const budget` must be an object literal: {{ js: <KB of gzip JS> }}");
            };
            for prop in &obj.properties {
                let ObjectPropertyKind::ObjectProperty(p) = prop else {
                    continue;
                };
                let key = match &p.key {
                    PropertyKey::StaticIdentifier(k) => k.name.as_str(),
                    PropertyKey::StringLiteral(s) => s.value.as_str(),
                    _ => continue,
                };
                if key != "js" {
                    continue;
                }
                return match unwrap_ts(&p.value) {
                    // 0 is allowed: "this page ships no client JS".
                    Expression::NumericLiteral(n) if n.value >= 0.0 && n.value.is_finite() => {
                        Ok(Some(n.value))
                    }
                    _ => bail!("`budget.js` must be a number literal, 0 or more (KB of gzip JS)"),
                };
            }
            bail!("`export const budget` has no `js` field: {{ js: <KB of gzip JS> }}");
        }
    }
    Ok(None)
}

/// Looks through `as const`, `satisfies T`, `<T>x`, `x!` and parentheses.
fn unwrap_ts<'a, 'b>(mut e: &'b Expression<'a>) -> &'b Expression<'a> {
    loop {
        e = match e {
            Expression::TSAsExpression(x) => &x.expression,
            Expression::TSSatisfiesExpression(x) => &x.expression,
            Expression::TSTypeAssertion(x) => &x.expression,
            Expression::TSNonNullExpression(x) => &x.expression,
            Expression::ParenthesizedExpression(x) => &x.expression,
            _ => return e,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget(src: &str) -> Result<Option<f64>> {
        parse_budget(Path::new("routes/x.tsx"), src)
    }

    #[test]
    fn reads_the_js_budget() {
        assert_eq!(
            budget("export const budget = { js: 20 };").unwrap(),
            Some(20.0)
        );
        assert_eq!(
            budget("export const budget = { js: 12.5 } as const;").unwrap(),
            Some(12.5)
        );
        assert_eq!(
            budget("export const budget = { \"js\": 8 } satisfies { js: number };").unwrap(),
            Some(8.0)
        );
        assert_eq!(budget("export default () => null;").unwrap(), None);
    }

    #[test]
    fn ignores_comments_and_other_names() {
        assert_eq!(
            budget("// export const budget = { js: 1 }\nexport const x = 1;").unwrap(),
            None
        );
        assert_eq!(budget("export const budgetX = { js: 1 };").unwrap(), None);
        assert_eq!(budget("const budget = { js: 1 };").unwrap(), None);
    }

    #[test]
    fn rejects_budgets_it_cannot_read() {
        assert!(budget("export const budget = 20;").is_err());
        assert!(budget("export const budget = { js: \"20\" };").is_err());
        assert!(budget("export const budget = { js: -1 };").is_err());
        assert_eq!(
            budget("export const budget = { js: 0 };").unwrap(),
            Some(0.0)
        );
        assert!(budget("const n = 20; export const budget = { js: n };").is_err());
        assert!(budget("export const budget = { css: 4 };").is_err());
    }

    #[test]
    fn detects_streaming_routes() {
        let p = Path::new("routes/x.tsx");
        assert!(is_streaming(p, "export const streaming = true;"));
        assert!(is_streaming(p, "export const streaming = \"early\";"));
        assert!(!is_streaming(p, "export const streaming = false;"));
        assert!(!is_streaming(
            p,
            "// export const streaming = true\nexport default () => null;"
        ));
        assert!(!is_streaming(
            p,
            "const streaming = true; export default () => streaming;"
        ));
    }

    #[test]
    fn finds_layouts_from_the_root_down() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        fs::create_dir_all(r.join("blog/deep")).unwrap();
        fs::write(r.join("_layout.tsx"), "").unwrap();
        fs::write(r.join("blog/_layout.tsx"), "").unwrap();
        fs::write(r.join("blog/deep/page.tsx"), "").unwrap();
        fs::write(r.join("_layout.notes"), "").unwrap();
        let mut got: Vec<_> = layouts_for(r, "blog/deep/page.tsx")
            .into_iter()
            .map(|p| {
                p.strip_prefix(r)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        got.sort();
        assert_eq!(got, ["_layout.tsx", "blog/_layout.tsx"]);
        assert_eq!(layouts_for(r, "about.tsx").len(), 1);
    }
}
