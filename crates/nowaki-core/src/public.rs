//! `public/`: files served as-is at their own path (`public/robots.txt` → `/robots.txt`).
//!
//! No transform, no hashing, no bundling: a `.css` or `.ts` in `public/` is sent as that file.
//! `nowaki build` copies the directory to `dist/public/`, which `nowaki start`, the adapters,
//! and the static output serve from. `nowaki dev` reads `public/` directly, so new files show up
//! without a restart.
//!
//! What is left out, everywhere:
//! - dotfiles and dot-directories (`.DS_Store`, `.env`), except `.well-known/`;
//! - `_nowaki/` and `__nowaki/` at the top: those URL prefixes belong to the framework, so a
//!   file there is a build error instead of a silently unreachable file.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// The source directory, `<root>/public`.
pub fn dir(root: &Path) -> PathBuf {
    root.join("public")
}

/// Whether a URL path segment (or a file name) may be served from `public/`.
fn segment_ok(seg: &str) -> bool {
    !seg.is_empty() && seg != ".." && (!seg.starts_with('.') || seg == ".well-known")
}

/// Whether a URL path starts with a prefix the framework owns.
fn reserved(url_path: &str) -> bool {
    let first = url_path
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or("");
    first == "_nowaki" || first == "__nowaki"
}

/// The file `url_path` names under `base` (a `public/` or `dist/public/` directory), if the path
/// is one that may be served. Doesn't touch the file system: the caller checks the file exists
/// and, for `nowaki dev`, that its real path stays inside `base`.
///
/// `url_path` is the request path as sent (percent-encoded); it's decoded here. Directories are
/// not resolved to an `index.html`: `/docs/` is a route's URL, not a file's.
pub fn resolve(base: &Path, url_path: &str) -> Option<PathBuf> {
    if !url_path.starts_with('/') || url_path.ends_with('/') || reserved(url_path) {
        return None;
    }
    let decoded = percent_decode(url_path)?;
    let mut out = base.to_path_buf();
    for seg in decoded.trim_start_matches('/').split('/') {
        if !segment_ok(seg) || seg.contains('\\') || seg.contains('\0') {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

/// Every file under `base`, as `(url path, file path)`, sorted by URL. Empty when `base` doesn't
/// exist. Skipped entries are the ones `resolve` would refuse.
pub fn list(base: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    if base.is_dir() {
        walk(base, "", &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    let entries =
        std::fs::read_dir(dir).with_context(|| format!("failed to read {}", dir.display()))?;
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue; // not UTF-8: no URL can name it
        };
        if !segment_ok(&name) {
            continue;
        }
        let url = format!("{prefix}/{name}");
        let path = entry.path();
        // `metadata` follows symlinks, so a linked file or directory is served like a real one.
        let meta = std::fs::metadata(&path)?;
        if meta.is_dir() {
            walk(&path, &url, out)?;
        } else if meta.is_file() {
            out.push((url, path));
        }
    }
    Ok(())
}

/// Copies `<root>/public` to `dest` (emptied first). Returns the number of files. A file under
/// `_nowaki/` or `__nowaki/` is an error.
pub fn copy_to(root: &Path, dest: &Path) -> Result<usize> {
    crate::build::clear_dir(dest)?;
    let files = list(&dir(root))?;
    if let Some((url, _)) = files.iter().find(|(url, _)| reserved(url)) {
        anyhow::bail!(
            "public{url}: `/_nowaki/` and `/__nowaki/` are reserved for the framework; move it elsewhere in public/"
        );
    }
    if files.is_empty() {
        return Ok(0);
    }
    for (url, src) in &files {
        let to = dest.join(url.trim_start_matches('/'));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, &to)
            .with_context(|| format!("failed to copy {} to {}", src.display(), to.display()))?;
    }
    Ok(files.len())
}

/// Content-Type by extension. Text types carry `charset=utf-8`; unknown ones are
/// `application/octet-stream`.
pub fn content_type(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path);
    let ext = match name.rsplit_once('.') {
        Some((_, ext)) => ext.to_ascii_lowercase(),
        None => return "application/octet-stream",
    };
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "rss" => "application/rss+xml",
        "atom" => "application/atom+xml",
        "ics" => "text/calendar; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Decodes `%XX`; None for malformed escapes or a result that isn't UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_plain_and_nested_paths() {
        let base = Path::new("/app/public");
        assert_eq!(resolve(base, "/robots.txt"), Some(base.join("robots.txt")));
        assert_eq!(
            resolve(base, "/fonts/Inter%20Var.woff2"),
            Some(base.join("fonts").join("Inter Var.woff2"))
        );
        assert_eq!(
            resolve(base, "/.well-known/security.txt"),
            Some(base.join(".well-known").join("security.txt"))
        );
    }

    #[test]
    fn refuses_traversal_dotfiles_reserved_and_directories() {
        let base = Path::new("/app/public");
        for p in [
            "/../secret",
            "/a/../../secret",
            "/%2e%2e/secret",
            "/a%2f..%2f..%2fsecret",
            "/.env",
            "/img/.DS_Store",
            "/_nowaki/x.js",
            "/__nowaki/live",
            "/docs/",
            "/",
            "relative.txt",
            "/a\\..\\b",
            "/bad%zz",
            "/nul%00.txt",
        ] {
            assert_eq!(resolve(base, p), None, "{p}");
        }
    }

    #[test]
    fn lists_and_copies_skipping_dotfiles() {
        let root = std::env::temp_dir().join(format!("nowaki-public-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let p = dir(&root);
        std::fs::create_dir_all(p.join("img")).unwrap();
        std::fs::create_dir_all(p.join(".well-known")).unwrap();
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::write(p.join("robots.txt"), "User-agent: *").unwrap();
        std::fs::write(p.join("img/logo.svg"), "<svg/>").unwrap();
        std::fs::write(p.join(".well-known/security.txt"), "x").unwrap();
        std::fs::write(p.join(".git/config"), "x").unwrap();
        std::fs::write(p.join(".DS_Store"), "x").unwrap();
        let urls: Vec<String> = list(&p).unwrap().into_iter().map(|(u, _)| u).collect();
        assert_eq!(
            urls,
            ["/.well-known/security.txt", "/img/logo.svg", "/robots.txt"]
        );

        let dest = root.join("dist/public");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("stale.txt"), "old").unwrap();
        assert_eq!(copy_to(&root, &dest).unwrap(), 3);
        assert!(!dest.join("stale.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("img/logo.svg")).unwrap(),
            "<svg/>"
        );

        std::fs::create_dir_all(p.join("_nowaki")).unwrap();
        std::fs::write(p.join("_nowaki/x.js"), "x").unwrap();
        assert!(copy_to(&root, &dest).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_public_dir_is_empty() {
        assert!(list(Path::new("/nonexistent/nowaki/public"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("/robots.txt"), "text/plain; charset=utf-8");
        assert_eq!(
            content_type("/site.webmanifest"),
            "application/manifest+json"
        );
        assert_eq!(content_type("/fonts/a.WOFF2"), "font/woff2");
        assert_eq!(content_type("/CNAME"), "application/octet-stream");
        assert_eq!(content_type("/v1.2/LICENSE"), "application/octet-stream");
    }
}
