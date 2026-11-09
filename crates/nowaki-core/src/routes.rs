//! File-based route enumeration under `routes/` (shared by typegen, prerender, and JS parity tests).
//!
//! URL patterns use Nowaki's on-disk syntax (`/blog/[slug]`, `/files/[...path]`). Convention
//! files (`_layout`, `loading`, …) and `api/` handlers are excluded from page-route scans.

use std::path::{Path, PathBuf};

use anyhow::Result;

pub const ROUTE_EXTENSIONS: [&str; 4] = ["tsx", "ts", "jsx", "js"];

/// `.mdx` pages (compiled to TSX, see mdx.rs). Kept out of ROUTE_EXTENSIONS so its type stays.
pub const MDX_EXTENSION: &str = "mdx";

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

/// Whether a directory name is a route group (`(marketing)`): it groups files without adding a
/// URL segment. Names starting with `.` (`(.)`, `(..)`) are reserved and stay literal. Matches
/// router.mjs `isRouteGroup`.
pub fn is_route_group(name: &str) -> bool {
    name.len() > 2
        && name.starts_with('(')
        && name.ends_with(')')
        && !name[1..].starts_with('.')
        && !name[1..name.len() - 1].contains([')', '/'])
}

/// A route stem or relative path without its route-group directories
/// (`(marketing)/about` → `about`). The last segment is a file name, never a group.
pub fn strip_route_groups(stem: &str) -> String {
    if !stem.contains('(') {
        return stem.to_string();
    }
    let parts: Vec<&str> = stem.split('/').collect();
    let last = parts.len() - 1;
    parts
        .iter()
        .enumerate()
        .filter(|(i, p)| *i == last || !is_route_group(p))
        .map(|(_, p)| *p)
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether a path under `routes/` is inside a parallel-route slot (`@modal/photo/[id].tsx`): any
/// segment starts with `@`. Slot files render inside their owner's `_layout`, never as pages.
/// Matches router.mjs `scanRoutes`.
pub fn is_slot_rel(rel: &str) -> bool {
    rel.split(['/', '\\']).any(|s| s.starts_with('@'))
}

/// Whether a path segment marks an intercepting route (`(.)photo`, `(..)photo`, `(...)photo`).
/// Matches router.mjs `isInterceptSegment`.
pub fn is_intercept_segment(seg: &str) -> bool {
    seg.starts_with("(.)") || seg.starts_with("(..)") || seg.starts_with("(...)")
}

/// Slot files and intercepting routes: neither is a page of its own.
pub fn is_slot_or_intercept_rel(rel: &str) -> bool {
    is_slot_rel(rel) || rel.split(['/', '\\']).any(is_intercept_segment)
}

pub fn is_api_route_rel(rel: &str) -> bool {
    let rel = strip_route_groups(&rel.replace('\\', "/"));
    rel == "api" || rel.starts_with("api/")
}

/// Whether a route stem's last segment names a file (`feed.xml`, `[card].png`): a file route,
/// which returns a body like an API route instead of rendering a page. Matches router.mjs.
pub fn is_file_route_stem(stem: &str) -> bool {
    let base = file_base_name(stem);
    let tail = base.rsplit_once(']').map_or(base, |(_, t)| t);
    tail.rsplit_once('.')
        .is_some_and(|(_, ext)| !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// API routes and file routes: neither renders a page (no typegen entry, no page budget).
pub fn is_endpoint_rel(rel: &str) -> bool {
    is_api_route_rel(rel) || stem_from_rel(rel).is_some_and(|s| is_file_route_stem(&s))
}

/// Stem path without extension (e.g. `blog/[slug]`).
pub fn stem_from_rel(rel: &str) -> Option<String> {
    let rel = rel.replace('\\', "/");
    let (stem, ext) = rel.rsplit_once('.')?;
    (ROUTE_EXTENSIONS.contains(&ext) || ext == MDX_EXTENSION).then(|| stem.to_string())
}

/// URL pattern from a route stem (`blog/index` → `/blog`, `index` → `/`).
/// Route groups are left out (`(marketing)/about` → `/about`).
pub fn url_pattern_from_stem(stem: &str) -> String {
    let mut url = format!("/{}", strip_route_groups(stem));
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
    if is_convention_source(base) || is_endpoint_rel(rel) || is_slot_or_intercept_rel(rel) {
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
/// File routes are listed by static-paths.mjs instead (written to their own path, not index.html).
pub fn is_static_prerender_stem(stem: &str) -> bool {
    !is_api_route_rel(stem)
        && !stem.contains('[')
        && !is_file_route_stem(stem)
        && !is_convention_source(file_base_name(stem))
        && !is_slot_or_intercept_rel(stem)
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
        if is_convention_source(base) || is_endpoint_rel(&rel) || is_slot_or_intercept_rel(&rel) {
            continue;
        }
        out.push(url_pattern_from_stem(&stem));
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// The files of every parallel-route slot under `routes/`, as `"<owner dir>/@<name> <URL pattern>"`
/// (`"/@modal /photo/[id]"`, owner dir `""` for `routes/`) or `"<owner dir>/@<name> default"`,
/// sorted. A slot file's pattern is its owner directory's URL followed by its own path. Files
/// starting with `_`, `loading` / `error`, nested slots, intercepting routes and nested
/// `default`s are left out, as router.mjs `scanRoutes` leaves them out of a slot's routes.
pub fn slot_route_patterns(routes_dir: &Path) -> Result<Vec<String>> {
    let mut files = walk_routes_dir(routes_dir)?;
    files.sort();
    let mut out = Vec::new();
    for abs in files {
        let Some(rel) = rel_posix(&abs, routes_dir) else {
            continue;
        };
        let Some(stem) = stem_from_rel(&rel) else {
            continue;
        };
        let parts: Vec<&str> = stem.split('/').collect();
        let Some(at) = parts.iter().position(|p| p.starts_with('@')) else {
            continue;
        };
        let inner = &parts[at + 1..];
        let base = file_base_name(&stem);
        if parts[at].len() < 2
            || inner.is_empty()
            || inner
                .iter()
                .any(|p| p.starts_with('@') || is_intercept_segment(p))
            || is_convention_source(base)
            || is_file_route_stem(base)
        {
            continue;
        }
        let owner = parts[..at]
            .iter()
            .map(|p| format!("/{p}"))
            .collect::<String>();
        let slot = format!("{owner}/{}", parts[at]);
        if base == "default" {
            if inner.len() == 1 {
                out.push(format!("{slot} default"));
            }
            continue;
        }
        let path: Vec<&str> = parts[..at].iter().chain(inner).copied().collect();
        out.push(format!("{slot} {}", url_pattern_from_stem(&path.join("/"))));
    }
    out.sort();
    Ok(out)
}

/// Fails when two route files serve the same URL because of route groups (`(a)/about.tsx` and
/// `(b)/about.tsx`, or `about.tsx` and `(b)/about.tsx`). Param names don't matter (`[slug]` and
/// `[id]` collide). Duplicates without a group (`about.tsx` and `about/index.tsx`) are left alone.
/// Matches router.mjs `scanRoutes`.
pub fn check_url_conflicts(routes_dir: &Path) -> Result<()> {
    let mut files = walk_routes_dir(routes_dir)?;
    files.sort();
    let mut seen: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for abs in files {
        let Some(rel) = rel_posix(&abs, routes_dir) else {
            continue;
        };
        let Some(stem) = stem_from_rel(&rel) else {
            continue;
        };
        if file_base_name(&stem).starts_with('_')
            || matches!(file_base_name(&stem), "loading" | "error")
            || is_slot_or_intercept_rel(&rel)
        {
            continue;
        }
        let in_group = strip_route_groups(&stem) != stem;
        let url = url_pattern_from_stem(&stem);
        let key = url
            .split('/')
            .filter(|s| !s.is_empty())
            .map(segment_shape)
            .collect::<Vec<_>>()
            .join("/");
        match seen.get(&key) {
            Some((prev, prev_group)) if *prev_group || in_group => {
                anyhow::bail!(
                    "routes/{prev} and routes/{rel} both serve {url}: route groups \"(name)\" add no URL segment. Rename or move one of them."
                );
            }
            Some(_) => {}
            None => {
                seen.insert(key, (rel, in_group));
            }
        }
    }
    Ok(())
}

/// A URL segment with its param name dropped, read as router.mjs `parseSegment` reads it.
fn segment_shape(seg: &str) -> String {
    if seg.starts_with("[...") && seg.ends_with(']') && seg.len() > 5 {
        return "*".to_string();
    }
    if let Some(rest) = seg.strip_prefix('[') {
        if let Some((name, tail)) = rest.split_once(']') {
            if !name.is_empty() && !name.contains('.') && tail.starts_with('.') && tail.len() > 1 {
                return format!(":{tail}");
            }
        }
        if seg.ends_with(']') && seg.len() > 2 {
            return ":".to_string();
        }
    }
    format!("={seg}")
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
        assert!(!is_static_prerender_stem("feed.xml"));
    }

    #[test]
    fn file_routes_are_endpoints() {
        assert!(is_file_route_stem("feed.xml"));
        assert!(is_file_route_stem("og/[card].png"));
        assert!(is_file_route_stem("sitemap.xml"));
        assert!(!is_file_route_stem("blog/[slug]"));
        assert!(!is_file_route_stem("about"));
        assert!(!is_file_route_stem("[...rest]"));
        assert!(!is_file_route_stem("v1.2/index"));
        assert!(is_endpoint_rel("og/[card].png.ts"));
        assert!(is_endpoint_rel("api/hello.ts"));
        assert!(!is_endpoint_rel("blog/[slug].tsx"));
        assert_eq!(typegen_entry("feed.xml.ts"), None);
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

    #[test]
    fn route_groups_leave_the_url() {
        assert!(is_route_group("(marketing)"));
        assert!(is_route_group("(a b)"));
        assert!(!is_route_group("(.)"));
        assert!(!is_route_group("(..)photo"));
        assert!(!is_route_group("(...)"));
        assert!(!is_route_group("()"));
        assert!(!is_route_group("marketing"));
        assert!(!is_route_group("(a)b"));
        assert_eq!(strip_route_groups("(marketing)/about"), "about");
        assert_eq!(strip_route_groups("(a)/docs/(b)/[slug]"), "docs/[slug]");
        assert_eq!(strip_route_groups("(.)/x"), "(.)/x");
        assert_eq!(
            strip_route_groups("blog/(x)"),
            "blog/(x)",
            "a file name is never a group"
        );
        assert_eq!(
            entry("(marketing)/about.tsx"),
            Some(("/about".into(), "{}".into()))
        );
        assert_eq!(
            entry("(marketing)/index.tsx"),
            Some(("/".into(), "{}".into()))
        );
        assert_eq!(
            entry("(shop)/items/[id].tsx"),
            Some(("/items/[id]".into(), "{ id: string }".into()))
        );
        assert_eq!(entry("(marketing)/_layout.tsx"), None);
        assert_eq!(entry("(marketing)/loading.tsx"), None);
        assert_eq!(
            entry("(x)/api/hello.ts"),
            None,
            "api/ under a group is still an API route"
        );
        assert!(is_api_route_rel("(x)/api/hello.ts"));
        assert!(!is_static_prerender_stem("(x)/api/hello"));
        assert!(is_static_prerender_stem("(marketing)/about"));
        assert_eq!(url_pattern_from_stem("(marketing)/about"), "/about");
    }

    #[test]
    fn route_group_prerender_and_page_urls() {
        let tmp = tempfile::tempdir().unwrap();
        let routes = tmp.path().join("routes");
        std::fs::create_dir_all(routes.join("(marketing)")).unwrap();
        for f in [
            "(marketing)/pricing.tsx",
            "(marketing)/_layout.tsx",
            "index.tsx",
        ] {
            std::fs::write(routes.join(f), "export default () => null;\n").unwrap();
        }
        assert_eq!(
            page_url_patterns(&routes).unwrap(),
            vec!["/".to_string(), "/pricing".to_string()]
        );
        check_url_conflicts(&routes).expect("no conflict");

        let build = tmp.path().join("dist");
        std::fs::create_dir_all(build.join("(marketing)")).unwrap();
        std::fs::write(build.join("(marketing)/pricing.js"), "").unwrap();
        std::fs::write(build.join("(marketing)/_layout.js"), "").unwrap();
        assert_eq!(
            enumerate_static_prerender_urls(&build).unwrap(),
            vec!["/pricing".to_string()]
        );
    }

    #[test]
    fn route_group_url_conflicts() {
        let conflict = |files: &[&str]| -> Option<String> {
            let tmp = tempfile::tempdir().unwrap();
            let routes = tmp.path().join("routes");
            for f in files {
                let p = routes.join(f);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, "export default () => null;\n").unwrap();
            }
            check_url_conflicts(&routes).err().map(|e| e.to_string())
        };
        let msg = conflict(&["(a)/about.tsx", "(b)/about.tsx"]).expect("conflict");
        assert!(msg.contains("routes/(a)/about.tsx"), "{msg}");
        assert!(msg.contains("routes/(b)/about.tsx"), "{msg}");
        assert!(msg.contains("/about"), "{msg}");
        assert!(conflict(&["about.tsx", "(b)/about.tsx"]).is_some());
        assert!(conflict(&["(a)/index.tsx", "index.tsx"]).is_some());
        assert!(conflict(&["(a)/blog/[slug].tsx", "blog/[id].tsx"]).is_some());
        assert!(conflict(&["(a)/f/[...p].tsx", "(b)/f/[...q].tsx"]).is_some());
        assert!(conflict(&["(a)/og/[c].png.ts", "(b)/og/[d].png.ts"]).is_some());
        assert!(conflict(&["(a)/og/[c].png.ts", "(b)/og/[d].jpg.ts"]).is_none());
        assert!(conflict(&["(a)/blog/[slug].tsx", "(b)/blog/new.tsx"]).is_none());
        assert!(conflict(&["(a)/_layout.tsx", "(b)/_layout.tsx"]).is_none());
        assert!(conflict(&["(a)/loading.tsx", "loading.tsx"]).is_none());
        assert!(
            conflict(&["about.tsx", "about/index.tsx"]).is_none(),
            "duplicates without a group are left as they were"
        );
        assert!(
            conflict(&[
                "photo/[id].tsx",
                "@modal/(g)/photo/[id].tsx",
                "@m/photo/[x].tsx"
            ])
            .is_none(),
            "slot files serve no URL of their own"
        );
    }

    #[test]
    fn slots_and_intercepts_are_not_pages() {
        assert!(is_slot_rel("@modal/default.tsx"));
        assert!(is_slot_rel("photos/@modal/[id].tsx"));
        assert!(is_slot_rel("a\\@m\\x.tsx"));
        assert!(!is_slot_rel("photos/[id].tsx"));
        assert!(!is_slot_rel("me@home.tsx"));
        assert!(is_intercept_segment("(.)photo"));
        assert!(is_intercept_segment("(..)photo"));
        assert!(is_intercept_segment("(...)photo"));
        assert!(is_intercept_segment("(..)(..)photo"));
        assert!(!is_intercept_segment("(marketing)"));
        assert!(!is_intercept_segment("photo"));
        assert_eq!(entry("@modal/default.tsx"), None);
        assert_eq!(entry("@modal/photo/[id].tsx"), None);
        assert_eq!(entry("photos/@modal/index.tsx"), None);
        assert_eq!(entry("feed/(..)photo/[id].tsx"), None);
        assert!(!is_static_prerender_stem("@modal/default"));
        assert!(!is_static_prerender_stem("photos/@modal/about"));
        assert!(!is_static_prerender_stem("@modal/(.)photo/index"));
    }

    #[test]
    fn slot_patterns_and_page_urls() {
        let tmp = tempfile::tempdir().unwrap();
        let routes = tmp.path().join("routes");
        for f in [
            "_layout.tsx",
            "index.tsx",
            "photo/[id].tsx",
            "@modal/default.tsx",
            "@modal/photo/[id].tsx",
            "@modal/(.)photo/[id].tsx",
            "@modal/_layout.tsx",
            "@modal/sub/default.tsx",
            "@modal/@inner/x.tsx",
            "@modal/feed.xml.ts",
            "(shop)/[org]/@cart/index.tsx",
            "(shop)/[org]/@cart/(g)/items.tsx",
            "@x.tsx",
            "feed/(..)photo/[id].tsx",
        ] {
            let p = routes.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "export default () => null;\n").unwrap();
        }
        assert_eq!(
            page_url_patterns(&routes).unwrap(),
            vec!["/".to_string(), "/photo/[id]".to_string()]
        );
        assert_eq!(
            slot_route_patterns(&routes).unwrap(),
            vec![
                "/(shop)/[org]/@cart /[org]".to_string(),
                "/(shop)/[org]/@cart /[org]/items".to_string(),
                "/@modal /photo/[id]".to_string(),
                "/@modal default".to_string(),
            ]
        );
        check_url_conflicts(&routes).expect("no conflict");
    }
}
