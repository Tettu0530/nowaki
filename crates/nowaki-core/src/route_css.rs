//! CSS that routes and layouts import, for the page's `<head>`.
//!
//! Only islands ship JS to the browser, so a route or layout's `import "../styles/site.css"`
//! can't inject the stylesheet itself. Instead the build follows each page route's import graph
//! (the route and every `_layout` above it, components included; also `_404` and `_500`),
//! collects the `.css` files it imports (plain and CSS Modules, app or package), and writes each
//! one once to `dist/client` as `<name>.<hash>.css`. The manifest maps each route to its
//! stylesheets (`routeCss`), keyed by the route's server module (`routes/blog/[slug].js`), and
//! the document links them.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use xxhash_rust::xxh3::xxh3_64;

use crate::routes::{is_convention_source, is_endpoint_rel, stem_from_rel};
use crate::NowakiCore;

/// The CSS files (absolute paths, in import order) that `entries` and the app modules they reach
/// statically import. Package modules and `import()` aren't followed, but a package CSS file
/// imported by the app counts.
pub fn css_of(core: &NowakiCore, entries: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen_css = HashSet::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<PathBuf> = entries.iter().rev().cloned().collect();
    while let Some(abs) = stack.pop() {
        if !seen.insert(abs.clone()) || !crate::chunk::is_app_module(core, &abs) {
            continue;
        }
        let Ok(imports) = crate::graph::module_imports(core, &abs) else {
            continue;
        };
        let mut next = Vec::new();
        for imp in imports {
            let Some(p) = imp.resolved else { continue };
            if crate::css::is_css(&p) {
                if seen_css.insert(p.clone()) {
                    out.push(p);
                }
            } else if !imp.dynamic {
                next.push(p);
            }
        }
        // Depth-first in source order, so a layout's CSS comes before the page's.
        stack.extend(next.into_iter().rev());
    }
    out
}

/// The stylesheet a CSS file becomes: CSS Modules are scoped with the same id as their JS.
fn stylesheet(core: &NowakiCore, abs: &Path) -> Option<String> {
    let css = core.read_css(abs).ok()?;
    if crate::css::is_css_module(abs) {
        let id = crate::css::css_scope_id(&core.root, abs);
        Some(crate::css::scope_css(&id, &css).0)
    } else {
        Some(css)
    }
}

/// Writes every page route's stylesheets into `client_dir` and returns `routeCss`: server module
/// key (`routes/x.js`) → file names, layouts' CSS first.
pub fn build_route_css(
    core: &NowakiCore,
    client_dir: &Path,
) -> Result<BTreeMap<String, Vec<String>>> {
    let routes_dir = core.root.join("routes");
    let mut map = BTreeMap::new();
    let mut emitted: HashMap<PathBuf, String> = HashMap::new();
    let mut names: BTreeSet<String> = BTreeSet::new();
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
        if is_endpoint_rel(&rel) || (is_convention_source(base) && base != "_404" && base != "_500")
        {
            continue;
        }
        let mut entries = crate::budget::layouts_for(&routes_dir, &rel);
        entries.push(path.clone());
        let mut files = Vec::new();
        for css in css_of(core, &entries) {
            let name = match emitted.get(&css) {
                Some(n) => n.clone(),
                None => {
                    let Some(sheet) = stylesheet(core, &css) else {
                        continue;
                    };
                    let file = css.file_name().map(|n| n.to_string_lossy());
                    let stem = crate::build::sanitize_name(
                        &file
                            .as_deref()
                            .unwrap_or("style.css")
                            .trim_end_matches(".css")
                            .replace('.', "-"),
                    );
                    let name = format!("{stem}.{:08x}.css", xxh3_64(sheet.as_bytes()) as u32);
                    if names.insert(name.clone()) {
                        fs::write(client_dir.join(&name), &sheet)?;
                    }
                    emitted.insert(css.clone(), name.clone());
                    name
                }
            };
            if !files.contains(&name) {
                files.push(name);
            }
        }
        if !files.is_empty() {
            map.insert(format!("routes/{stem}.js"), files);
        }
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, src) in files {
            let p = dir.path().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, src).unwrap();
        }
        dir
    }

    #[test]
    fn collects_layout_component_and_page_css_in_order() {
        let dir = app(&[
            ("routes/_layout.tsx", "import \"../styles/site.css\";\nexport default (p) => p.children;\n"),
            ("routes/blog/[slug].tsx", "import Card from \"../../components/Card.tsx\";\nimport \"./post.css\";\nexport default () => <Card />;\n"),
            ("routes/blog/post.css", ".post{}"),
            ("routes/about.tsx", "export default () => <p />;\n"),
            ("routes/api/x.ts", "import \"../../styles/site.css\";\nexport const GET = () => 1;\n"),
            ("components/Card.tsx", "import s from \"./Card.module.css\";\nexport default () => <div class={s.card} />;\n"),
            ("components/Card.module.css", ".card{color:red}"),
            ("styles/site.css", "body{margin:0}"),
        ]);
        let root = dunce::canonicalize(dir.path()).unwrap();
        let core = NowakiCore::new(root.clone());
        let out = root.join("client");
        fs::create_dir_all(&out).unwrap();
        let map = build_route_css(&core, &out).unwrap();

        let slug = &map["routes/blog/[slug].js"];
        assert_eq!(slug.len(), 3, "{map:?}");
        assert!(slug[0].starts_with("site."), "layout CSS first: {slug:?}");
        assert!(
            slug.iter().any(|f| f.starts_with("Card-module.")),
            "{slug:?}"
        );
        assert!(slug.iter().any(|f| f.starts_with("post.")), "{slug:?}");
        // The layout wraps /about too; API routes get none.
        assert_eq!(map["routes/about.js"].len(), 1);
        assert!(!map.contains_key("routes/api/x.js"));
        // CSS Modules are written scoped, the same way their JS scopes the class names.
        let card = slug.iter().find(|f| f.starts_with("Card-module.")).unwrap();
        let text = fs::read_to_string(out.join(card)).unwrap();
        assert!(
            text.contains(".card_") && !text.contains(".card{"),
            "{text}"
        );
        // Each file is written once even when many routes share it.
        let site = fs::read_dir(&out)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("site.")
            })
            .count();
        assert_eq!(site, 1);
    }
}
