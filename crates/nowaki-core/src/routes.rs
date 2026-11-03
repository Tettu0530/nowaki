//! File-based route enumeration under `routes/` (shared by typegen, prerender, and JS parity tests).
//!
//! URL patterns use Nowaki's on-disk syntax (`/blog/[slug]`, `/files/[...path]`). Convention
//! files (`_layout`, `loading`, …) and `api/` handlers are excluded from page-route scans.

use std::path::{Path, PathBuf};

use anyhow::Result;

pub const ROUTE_EXTENSIONS: [&str; 4] = ["tsx", "ts", "jsx", "js"];

/// Recursively lists files under `routes_dir`.
pub fn walk_routes_dir(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    walk_dir(dir, &mut out)?;
    Ok(out)
}

fn walk_dir(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

fn rel_posix(path: &Path, routes_dir: &Path) -> Option<String> {
    path.strip_prefix(routes_dir)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
}

fn file_base_name(stem_path: &str) -> &str {
    stem_path.rsplit('/').next().unwrap_or(stem_path)
}

/// Convention / boundary sources under `routes/` (not navigable pages for typegen).
pub fn is_convention_source(base: &str) -> bool {
    base.starts_with('_') || base == "loading" || base == "error"
}

pub fn is_api_route_rel(rel: &str) -> bool {
    rel == "api" || rel.starts_with("api/")
}

/// Stem path without extension (e.g. `blog/[slug]`).
pub fn stem_from_rel(rel: &str) -> Option<String> {
    let rel = rel.replace('\\', "/");
    let (stem, ext) = rel.rsplit_once('.')?;
    ROUTE_EXTENSIONS.contains(&ext).then(|| stem.to_string())
}

/// URL pattern from a route stem (`blog/index` → `/blog`, `index` → `/`).
pub fn url_pattern_from_stem(stem: &str) -> String {
    let mut url = format!("/{stem}");
    if let Some(stripped) = url.strip_suffix("/index") {
        url = stripped.to_string();
    }
    if url.is_empty() {
        url = "/".to_string();
    }
    url
}

/// Typegen entry: URL pattern and TS param type. None for conventions, API, or unsupported ext.
pub fn typegen_entry(rel: &str) -> Option<(String, String)> {
    let stem = stem_from_rel(rel)?;
    let base = file_base_name(&stem);
    if is_convention_source(base) || is_api_route_rel(rel) {
        return None;
    }

    let url = url_pattern_from_stem(&stem);
    let mut params: Vec<String> = Vec::new();
    for seg in url.split('/').filter(|s| !s.is_empty()) {
        if let Some(name) = seg.strip_prefix("[...").and_then(|s| s.strip_suffix(']')) {
            params.push(format!("{name}: string[]"));
        } else if let Some(name) = seg.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            params.push(format!("{name}: string"));
        }
    }
    let params_ty = if params.is_empty() {
        "{}".to_string()
    } else {
        format!("{{ {} }}", params.join("; "))
    };
    Some((url, params_ty))
}

/// Sorted, deduped typegen rows for `routes/`.
pub fn scan_typegen(routes_dir: &Path) -> Result<Vec<(String, String)>> {
    let mut files = walk_routes_dir(routes_dir)?;
    files.sort();
    let mut out: Vec<(String, String)> = Vec::new();
    for abs in files {
        let Some(rel) = rel_posix(&abs, routes_dir) else {
            continue;
        };
        if let Some(entry) = typegen_entry(&rel) {
            out.push(entry);
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Whether a built server route stem (`dist/server/routes/...` without `.js`) is a static HTML prerender target.
pub fn is_static_prerender_stem(stem: &str) -> bool {
    !stem.starts_with("api/") && !stem.contains('[') && !is_convention_source(file_base_name(stem))
}

/// Static prerender URLs from compiled `dist/server/routes/**/*.js`.
pub fn enumerate_static_prerender_urls(routes_dir: &Path) -> Result<Vec<String>> {
    let mut urls = Vec::new();
    if !routes_dir.is_dir() {
        return Ok(urls);
    }
    for path in walk_routes_dir(routes_dir)? {
        let Some(rel) = rel_posix(&path, routes_dir) else {
            continue;
        };
        let Some(stem) = rel.strip_suffix(".js") else {
            continue;
        };
        if !is_static_prerender_stem(stem) {
            continue;
        }
        urls.push(url_pattern_from_stem(stem));
    }
    urls.sort();
    Ok(urls)
}

/// Page URL patterns under source `routes/` (non-API), for parity with `scanRoutes` in router.mjs.
pub fn page_url_patterns(routes_dir: &Path) -> Result<Vec<String>> {
    let mut files = walk_routes_dir(routes_dir)?;
    files.sort();
    let mut out: Vec<String> = Vec::new();
    for abs in files {
        let Some(rel) = rel_posix(&abs, routes_dir) else {
            continue;
        };
        let Some(stem) = stem_from_rel(&rel) else {
            continue;
        };
        let base = file_base_name(&stem);
        if is_convention_source(base) || is_api_route_rel(&rel) {
            continue;
        }
        out.push(url_pattern_from_stem(&stem));
    }
    out.sort();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(rel: &str) -> Option<(String, String)> {
        typegen_entry(rel)
    }

    #[test]
    fn static_and_index_routes() {
        assert_eq!(entry("index.tsx"), Some(("/".into(), "{}".into())));
        assert_eq!(entry("about.tsx"), Some(("/about".into(), "{}".into())));
        assert_eq!(entry("blog/index.tsx"), Some(("/blog".into(), "{}".into())));
    }

    #[test]
    fn dynamic_and_catch_all_params() {
        assert_eq!(
            entry("blog/[slug].tsx"),
            Some(("/blog/[slug]".into(), "{ slug: string }".into()))
        );
        assert_eq!(
            entry("files/[...path].tsx"),
            Some(("/files/[...path]".into(), "{ path: string[] }".into()))
        );
        assert_eq!(
            entry("users/[id]/posts/[pid].tsx"),
            Some((
                "/users/[id]/posts/[pid]".into(),
                "{ id: string; pid: string }".into()
            ))
        );
    }

    #[test]
    fn conventions_and_api_are_excluded() {
        assert_eq!(entry("_layout.tsx"), None);
        assert_eq!(entry("_404.tsx"), None);
        assert_eq!(entry("_middleware.ts"), None);
        assert_eq!(entry("loading.tsx"), None);
        assert_eq!(entry("error.tsx"), None);
        assert_eq!(entry("api/hello.ts"), None);
        assert_eq!(entry("api/posts/[id].ts"), None);
        assert_eq!(entry("readme.md"), None);
    }

    #[test]
    fn static_prerender_stems() {
        assert!(is_static_prerender_stem("index"));
        assert!(is_static_prerender_stem("about"));
        assert!(is_static_prerender_stem("error/index"));
        assert!(!is_static_prerender_stem("blog/[slug]"));
        assert!(!is_static_prerender_stem("api/hello"));
        assert!(!is_static_prerender_stem("_404"));
        assert!(!is_static_prerender_stem("loading"));
        assert!(!is_static_prerender_stem("blog/loading"));
        assert!(!is_static_prerender_stem("foo/error"));
    }

    #[test]
    fn prerender_stems_match_typegen_convention_rule() {
        let tmp = tempfile::tempdir().unwrap();
        let routes = tmp.path().join("routes");
        std::fs::create_dir_all(routes.join("error")).unwrap();
        std::fs::create_dir_all(routes.join("blog")).unwrap();
        std::fs::write(
            routes.join("error/index.tsx"),
            "export default () => null;\n",
        )
        .unwrap();
        std::fs::write(
            routes.join("blog/loading.tsx"),
            "export default () => null;\n",
        )
        .unwrap();

        let urls = page_url_patterns(&routes).expect("scan");
        assert!(urls.contains(&"/error".to_string()));
        assert!(!urls.iter().any(|u| u.contains("loading")));

        let build = tmp.path().join("dist");
        std::fs::create_dir_all(build.join("error")).unwrap();
        std::fs::create_dir_all(build.join("blog")).unwrap();
        std::fs::write(build.join("error/index.js"), "").unwrap();
        std::fs::write(build.join("blog/loading.js"), "").unwrap();
        let prerender = enumerate_static_prerender_urls(&build).expect("prerender urls");
        assert_eq!(prerender, vec!["/error".to_string()]);
    }

    #[test]
    fn enumerate_static_from_build_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::create_dir_all(dir.join("blog")).unwrap();
        std::fs::write(dir.join("index.js"), "").unwrap();
        std::fs::write(dir.join("about.js"), "").unwrap();
        std::fs::write(dir.join("blog/[slug].js"), "").unwrap();
        std::fs::write(dir.join("blog/index.js"), "").unwrap();
        let urls = enumerate_static_prerender_urls(dir).unwrap();
        assert_eq!(
            urls,
            vec!["/".to_string(), "/about".to_string(), "/blog".to_string()]
        );
    }
}
