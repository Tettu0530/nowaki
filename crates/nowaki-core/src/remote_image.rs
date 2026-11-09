//! Remote images for `?image`: `import hero from "https://images.example.com/a.jpg?image"`.
//!
//! nowaki-core runs no JavaScript and has no TLS, so the download itself happens elsewhere,
//! through [`RemoteFetch`] (the CLI runs `server/images-fetch.mjs` in Node). This module decides
//! what may be fetched and where it lands:
//!
//! - A URL is fetched only when `images.remotePatterns` (nowaki.config) allows it; the check
//!   runs here, before any fetch. The fetcher must check every redirect target against the same
//!   patterns and refuse private, loopback and link-local addresses.
//! - Downloads are cached under `node_modules/.cache/nowaki/images/remote/<sha256(url)>/`
//!   (`<stem>.<ext>` and `meta.json`). A cached URL is answered from disk without calling the
//!   fetcher, so a build with every image cached starts no Node process and needs no network.
//!   `NOWAKI_IMAGES_REFRESH=1` fetches each URL again (once per process).
//! - A fetched file must decode as a PNG, JPEG, WebP or GIF image within the size limits before
//!   it is used; anything else is deleted and reported.
//!
//! The cached file then goes through the same pipeline as a local `?image` import.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

/// The largest download accepted (the fetcher aborts past it; checked again here).
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// The most pixels a remote image may decode to (a small file can declare a huge canvas).
pub const MAX_PIXELS: u64 = 50_000_000;
/// Formats a remote image may have, by the extension the fetcher gives the file.
const EXTENSIONS: [&str; 4] = ["png", "jpg", "webp", "gif"];

/// One entry of `images.remotePatterns`, as `server/site-config.mjs` normalized it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemotePattern {
    /// `"https"` or `"http"`; omitted means `"https"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// A host name; `*.` matches one label, `**.` any number (at least one) of labels.
    pub hostname: String,
    /// A port number; omitted means the scheme's default port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    /// A path glob: `*` matches within a segment, `**` across segments. Omitted means any path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pathname: Option<String>,
}

/// One download for [`RemoteFetch`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteRequest {
    pub url: String,
    /// The directory to write into (created by the fetcher).
    pub dir: PathBuf,
    /// The file name without extension; the fetcher adds the extension of the format it found.
    pub stem: String,
}

/// Downloads remote images. Implemented by the CLI (nowaki-core runs no JS and has no TLS).
///
/// For each request the fetcher writes `<dir>/<stem>.<ext>` (`ext` one of `png`, `jpg`,
/// `webp`, `gif`, from the bytes, not the URL), then `<dir>/meta.json` holding at least
/// `{ "url": <request url>, "file": "<stem>.<ext>" }`. It must refuse URLs and redirect targets
/// that `patterns` don't allow, private / loopback / link-local addresses, bodies over
/// [`MAX_BYTES`], and slow responses. Returns one result per request, in order.
pub trait RemoteFetch: Send + Sync {
    fn fetch(&self, patterns: &[RemotePattern], requests: &[RemoteRequest]) -> Vec<Result<()>>;
}

/// The parts of a remote URL the patterns look at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteUrl<'a> {
    pub protocol: &'a str,
    /// Lowercase.
    pub hostname: String,
    /// None for the scheme's default port.
    pub port: Option<u16>,
    pub pathname: &'a str,
}

/// Parses an absolute `http(s)://host[:port]/path[?query]` URL, strictly: no user info, no
/// fragment, no IP-literal brackets, no whitespace or backslashes, host labels of
/// `[a-z0-9-]` only, and no `.` / `..` or encoded `/` / `\` in the path (a server could resolve
/// those outside the allowed path). None for anything else; such a URL is never allowed.
pub fn parse_remote_url(url: &str) -> Option<RemoteUrl<'_>> {
    if url
        .bytes()
        .any(|b| b <= b' ' || b == 0x7f || b == b'\\' || b == b'#' || b >= 0x80)
    {
        return None;
    }
    let (protocol, rest) = url.split_once("://")?;
    if protocol != "https" && protocol != "http" {
        return None;
    }
    let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(auth_end);
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => {
            if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if n == 0 || n > 65535 {
                return None;
            }
            (h, Some(n as u16))
        }
        None => (authority, None),
    };
    let hostname = host.to_ascii_lowercase();
    if !valid_hostname(&hostname) {
        return None;
    }
    let default = if protocol == "https" { 443 } else { 80 };
    let port = port.filter(|p| *p != default);
    let pathname = match tail.split_once('?') {
        Some((p, _)) => p,
        None => tail,
    };
    let pathname = if pathname.is_empty() { "/" } else { pathname };
    if !pathname.starts_with('/') || !safe_path(pathname) {
        return None;
    }
    Some(RemoteUrl {
        protocol,
        hostname,
        port,
        pathname,
    })
}

fn valid_hostname(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn safe_path(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") {
        return false;
    }
    p.split('/').all(|seg| {
        let s = seg.to_ascii_lowercase().replace("%2e", ".");
        s != "." && s != ".."
    })
}

/// Whether `url` matches one of `patterns`. Unparsable URLs never match.
pub fn is_allowed(patterns: &[RemotePattern], url: &str) -> bool {
    let Some(u) = parse_remote_url(url) else {
        return false;
    };
    patterns.iter().any(|p| pattern_matches(p, &u))
}

fn pattern_matches(p: &RemotePattern, u: &RemoteUrl) -> bool {
    let protocol = p
        .protocol
        .as_deref()
        .map(|s| s.trim_end_matches(':'))
        .unwrap_or("https");
    if protocol != u.protocol {
        return false;
    }
    let want_port = match p.port.as_deref() {
        None | Some("") => None,
        Some(s) => match s.parse::<u16>() {
            Ok(n) => Some(n),
            Err(_) => return false,
        },
    };
    let default = if u.protocol == "https" { 443 } else { 80 };
    if want_port.filter(|n| *n != default) != u.port {
        return false;
    }
    if !host_matches(&p.hostname.to_ascii_lowercase(), &u.hostname) {
        return false;
    }
    glob_match(
        p.pathname.as_deref().unwrap_or("/**").as_bytes(),
        u.pathname.as_bytes(),
    )
}

fn host_matches(pattern: &str, host: &str) -> bool {
    if let Some(rest) = pattern.strip_prefix("**.") {
        return host
            .strip_suffix(rest)
            .and_then(|pre| pre.strip_suffix('.'))
            .is_some_and(|pre| !pre.is_empty());
    }
    if let Some(rest) = pattern.strip_prefix("*.") {
        return host
            .strip_suffix(rest)
            .and_then(|pre| pre.strip_suffix('.'))
            .is_some_and(|pre| !pre.is_empty() && !pre.contains('.'));
    }
    pattern == host
}

/// `**` matches anything (including `/`), `*` anything but `/`; everything else is literal.
fn glob_match(pat: &[u8], s: &[u8]) -> bool {
    if pat.starts_with(b"**") {
        let rest = &pat[2..];
        return (0..=s.len()).any(|i| glob_match(rest, &s[i..]));
    }
    match pat.first() {
        None => s.is_empty(),
        Some(b'*') => {
            let rest = &pat[1..];
            for i in 0..=s.len() {
                if glob_match(rest, &s[i..]) {
                    return true;
                }
                if s.get(i) == Some(&b'/') {
                    break;
                }
            }
            false
        }
        Some(c) => s.first() == Some(c) && glob_match(&pat[1..], &s[1..]),
    }
}

/// The cache directory for `url`.
pub fn cache_dir(root: &Path, url: &str) -> PathBuf {
    root.join("node_modules/.cache/nowaki/images/remote")
        .join(sha256_hex(url.as_bytes()))
}

/// `meta.json` of `url`'s cache entry (present once a download completed).
pub fn meta_path(root: &Path, url: &str) -> PathBuf {
    cache_dir(root, url).join("meta.json")
}

#[derive(Deserialize)]
struct Meta {
    url: String,
    file: String,
}

/// The cached file for `url`, if a complete download is on disk. Reads only `meta.json`.
pub fn cached(root: &Path, url: &str) -> Option<PathBuf> {
    let dir = cache_dir(root, url);
    let meta: Meta = serde_json::from_slice(&std::fs::read(dir.join("meta.json")).ok()?).ok()?;
    if meta.url != url || !valid_file_name(&meta.file) {
        return None;
    }
    let file = dir.join(&meta.file);
    file.is_file().then_some(file)
}

fn valid_file_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && EXTENSIONS.contains(&ext)
}

/// A file stem from the URL's last path segment (`/photos/a.jpg` → `a`), for readable output
/// names; `image` when nothing usable is left.
fn stem_of(url: &str) -> String {
    let path = parse_remote_url(url).map(|u| u.pathname).unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    let base = last.split('.').next().unwrap_or("");
    let stem: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    if stem.is_empty() {
        "image".to_string()
    } else {
        stem
    }
}

/// Checks a fetched file: an allowed extension, at most [`MAX_BYTES`], and its header decodes
/// as that format with at most [`MAX_PIXELS`].
fn validate(file: &Path) -> Result<()> {
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
    let expected = match ext {
        "png" => image::ImageFormat::Png,
        "jpg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        "gif" => image::ImageFormat::Gif,
        _ => return Err(anyhow!("not a PNG, JPEG, WebP or GIF image")),
    };
    let len = std::fs::metadata(file)?.len();
    if len > MAX_BYTES {
        return Err(anyhow!("larger than {} MB", MAX_BYTES / 1024 / 1024));
    }
    let raw = std::fs::read(file)?;
    let reader = image::ImageReader::new(std::io::Cursor::new(&raw)).with_guessed_format()?;
    if reader.format() != Some(expected) {
        return Err(anyhow!("not a PNG, JPEG, WebP or GIF image"));
    }
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| anyhow!("doesn't decode as an image: {e}"))?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(anyhow!("{w}x{h} is outside the size limit"));
    }
    Ok(())
}

/// Remote images for one app: the allow-list, the fetcher, and the cache.
pub struct RemoteImages {
    root: PathBuf,
    patterns: Vec<RemotePattern>,
    fetcher: Option<Arc<dyn RemoteFetch>>,
    refresh: bool,
    /// URLs downloaded by this process (with `refresh`, each is fetched again only once).
    fetched: Mutex<HashSet<String>>,
    /// Serializes downloads, so concurrent dev requests fetch a URL once; cache hits don't wait.
    fetch_lock: Mutex<()>,
}

impl RemoteImages {
    /// `fetcher` None: only cached images are available (a miss is an error).
    pub fn new(
        root: PathBuf,
        patterns: Vec<RemotePattern>,
        fetcher: Option<Arc<dyn RemoteFetch>>,
    ) -> Self {
        let refresh = std::env::var("NOWAKI_IMAGES_REFRESH").is_ok_and(|v| v == "1");
        Self {
            root,
            patterns,
            fetcher,
            refresh,
            fetched: Mutex::new(HashSet::new()),
            fetch_lock: Mutex::new(()),
        }
    }

    pub fn patterns(&self) -> &[RemotePattern] {
        &self.patterns
    }

    pub fn allowed(&self, url: &str) -> bool {
        is_allowed(&self.patterns, url)
    }

    /// A value that changes with the patterns (mixed into transform cache keys: MDX output
    /// depends on which remote images are allowed).
    pub(crate) fn salt(&self) -> u64 {
        let json = serde_json::to_string(&self.patterns).unwrap_or_default();
        xxhash_rust::xxh3::xxh3_64(json.as_bytes())
    }

    fn hit(&self, url: &str, fetched: &HashSet<String>) -> Option<PathBuf> {
        if self.refresh && !fetched.contains(url) {
            return None;
        }
        cached(&self.root, url)
    }

    /// The cached file for each URL, downloading the misses in one fetcher call. A URL the
    /// patterns don't allow is refused here, before anything is fetched.
    pub fn ensure(&self, urls: &[String]) -> Vec<Result<PathBuf>> {
        let mut out: Vec<Option<Result<PathBuf>>> = urls
            .iter()
            .map(|url| {
                (!self.allowed(url)).then(|| {
                    Err(anyhow!(
                        "remote image {url} is not allowed by images.remotePatterns in nowaki.config"
                    ))
                })
            })
            .collect();
        // The fast path: everything cached, no download lock taken.
        {
            let fetched = self.fetched.lock().unwrap();
            for (i, url) in urls.iter().enumerate() {
                if out[i].is_none() {
                    if let Some(p) = self.hit(url, &fetched) {
                        out[i] = Some(Ok(p));
                    }
                }
            }
        }
        if out.iter().all(Option::is_some) {
            return out.into_iter().map(Option::unwrap).collect();
        }
        let _downloading = self.fetch_lock.lock().unwrap();
        let fetched = self.fetched.lock().unwrap();
        let mut requests: Vec<RemoteRequest> = Vec::new();
        for (i, url) in urls.iter().enumerate() {
            if out[i].is_some() {
                continue;
            }
            // Another thread may have fetched it while this one waited for the lock.
            if let Some(p) = self.hit(url, &fetched) {
                out[i] = Some(Ok(p));
            } else if !requests.iter().any(|r| &r.url == url) {
                requests.push(RemoteRequest {
                    url: url.clone(),
                    dir: cache_dir(&self.root, url),
                    stem: stem_of(url),
                });
            }
        }
        drop(fetched);
        let results: Vec<Result<()>> = match &self.fetcher {
            Some(f) if !requests.is_empty() => {
                for r in &requests {
                    let _ = std::fs::remove_dir_all(&r.dir);
                }
                let mut res = f.fetch(&self.patterns, &requests);
                res.resize_with(requests.len(), || {
                    Err(anyhow!("the image fetcher returned no result"))
                });
                res
            }
            Some(_) => Vec::new(),
            None => requests
                .iter()
                .map(|_| Err(anyhow!("not cached, and no image fetcher is available")))
                .collect(),
        };
        let mut fetched = self.fetched.lock().unwrap();
        let mut done: Vec<(String, std::result::Result<PathBuf, String>)> = Vec::new();
        for (req, res) in requests.iter().zip(results) {
            let checked = res
                .and_then(|()| {
                    cached(&self.root, &req.url)
                        .ok_or_else(|| anyhow!("the image fetcher wrote no file"))
                })
                .and_then(|file| validate(&file).map(|()| file));
            if checked.is_err() {
                let _ = std::fs::remove_dir_all(&req.dir);
            }
            fetched.insert(req.url.clone());
            done.push((req.url.clone(), checked.map_err(|e| format!("{e:#}"))));
        }
        drop(fetched);
        urls.iter()
            .zip(out)
            .map(|(url, o)| {
                o.unwrap_or_else(
                    || match done.iter().find(|(u, _)| u == url).map(|(_, r)| r) {
                        Some(Ok(p)) => Ok(p.clone()),
                        Some(Err(e)) => Err(anyhow!("failed to fetch remote image {url}: {e}")),
                        None => Err(anyhow!("failed to fetch remote image {url}")),
                    },
                )
            })
            .collect()
    }

    /// [`ensure`](Self::ensure) for one URL.
    pub fn get(&self, url: &str) -> Result<PathBuf> {
        self.ensure(&[url.to_string()])
            .pop()
            .unwrap_or_else(|| Err(anyhow!("no result for {url}")))
    }
}

/// SHA-256 as lowercase hex (cache directory names, matching images-fetch.mjs).
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn strict_url_parsing() {
        let u = parse_remote_url("https://Images.Example.com:443/a/b.jpg?x=1").unwrap();
        assert_eq!(u.hostname, "images.example.com");
        assert_eq!(u.port, None);
        assert_eq!(u.pathname, "/a/b.jpg");
        for bad in [
            "ftp://a.com/x",
            "https://user@a.com/x",
            "https://a.com/x#y",
            "https://[::1]/x",
            "https://a.com/../x",
            "https://a.com/a/%2e%2e/x",
            "https://a.com/a%2fb",
            "https://a.com/a\\b",
            "https://a.com:0/x",
            "https://a.com:99999/x",
            "https://a..com/x",
            "https:///x",
        ] {
            assert!(parse_remote_url(bad).is_none(), "{bad}");
        }
    }

    #[derive(Clone, Copy)]
    enum Body {
        Png,
        Junk,
        Huge,
    }

    /// A fetcher that counts calls and writes `body` as `<stem>.png` for each request.
    struct Fake {
        calls: AtomicUsize,
        body: Body,
    }

    impl RemoteFetch for Fake {
        fn fetch(&self, _: &[RemotePattern], reqs: &[RemoteRequest]) -> Vec<Result<()>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            reqs.iter()
                .map(|r| {
                    std::fs::create_dir_all(&r.dir)?;
                    let file = format!("{}.png", r.stem);
                    let path = r.dir.join(&file);
                    match self.body {
                        Body::Png => image::RgbImage::new(8, 4).save(&path)?,
                        Body::Junk => std::fs::write(&path, b"<svg onload=alert(1)>")?,
                        // 7072² > MAX_PIXELS, but a small file (one flat colour).
                        Body::Huge => image::GrayImage::new(7072, 7072).save(&path)?,
                    }
                    std::fs::write(
                        r.dir.join("meta.json"),
                        serde_json::json!({ "url": r.url, "file": file }).to_string(),
                    )?;
                    Ok(())
                })
                .collect()
        }
    }

    fn patterns() -> Vec<RemotePattern> {
        vec![RemotePattern {
            protocol: Some("https".into()),
            hostname: "images.example.com".into(),
            port: None,
            pathname: Some("/photos/**".into()),
        }]
    }

    #[test]
    fn refuses_before_fetching_and_batches_misses() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(Fake {
            calls: AtomicUsize::new(0),
            body: Body::Png,
        });
        let remote = RemoteImages::new(dir.path().to_path_buf(), patterns(), Some(fake.clone()));
        let err = remote
            .get("https://evil.example.com/photos/a.png")
            .unwrap_err();
        assert!(err.to_string().contains("not allowed"), "{err}");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);

        let urls = vec![
            "https://images.example.com/photos/a.png".to_string(),
            "https://images.example.com/photos/b.png".to_string(),
            "https://images.example.com/secret/c.png".to_string(),
        ];
        let out = remote.ensure(&urls);
        assert_eq!(
            fake.calls.load(Ordering::SeqCst),
            1,
            "one fetch for both misses"
        );
        let a = out[0].as_ref().unwrap();
        assert!(a.ends_with("a.png") && a.starts_with(cache_dir(dir.path(), &urls[0])));
        assert!(out[1].is_ok());
        assert!(out[2].is_err());

        // A new process: everything cached, the fetcher is never called.
        let again = RemoteImages::new(dir.path().to_path_buf(), patterns(), Some(fake.clone()));
        assert!(again.ensure(&urls[..2]).iter().all(Result::is_ok));
        assert_eq!(
            fake.calls.load(Ordering::SeqCst),
            1,
            "a cache hit never fetches"
        );
        // Without a fetcher at all, hits still work.
        let offline = RemoteImages::new(dir.path().to_path_buf(), patterns(), None);
        assert!(offline.get(&urls[0]).is_ok());
        assert!(offline
            .get("https://images.example.com/photos/new.png")
            .is_err());
    }

    #[test]
    fn rejects_files_that_are_not_images_or_too_large_to_decode() {
        for (body, why) in [
            (Body::Junk, "not a PNG"),
            (Body::Huge, "outside the size limit"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let fake = Arc::new(Fake {
                calls: AtomicUsize::new(0),
                body,
            });
            let remote = RemoteImages::new(dir.path().to_path_buf(), patterns(), Some(fake));
            let url = "https://images.example.com/photos/x.png";
            let err = format!("{:#}", remote.get(url).unwrap_err());
            assert!(err.contains("x.png") && err.contains(why), "{err}");
            // Nothing usable is left in the cache.
            assert!(cached(dir.path(), url).is_none());
            assert!(!cache_dir(dir.path(), url).exists());
        }
    }

    #[test]
    fn a_file_over_the_byte_limit_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.png");
        image::RgbImage::new(4, 4).save(&file).unwrap();
        // Write access, not append: Windows refuses set_len on an append-only handle.
        let f = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        let err = validate(&file).unwrap_err().to_string();
        assert!(err.contains("larger than 20 MB"), "{err}");
    }

    #[test]
    fn meta_must_match_the_url_and_name_a_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://images.example.com/photos/a.png";
        let d = cache_dir(dir.path(), url);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.png"), b"x").unwrap();
        let meta = |u: &str, f: &str| {
            std::fs::write(
                d.join("meta.json"),
                serde_json::json!({ "url": u, "file": f }).to_string(),
            )
            .unwrap()
        };
        meta(url, "a.png");
        assert!(cached(dir.path(), url).is_some());
        meta("https://other/a.png", "a.png");
        assert!(cached(dir.path(), url).is_none());
        for f in ["../a.png", "a.svg", ".png", "a/b.png"] {
            meta(url, f);
            assert!(cached(dir.path(), url).is_none(), "{f}");
        }
    }

    #[test]
    fn stems_are_readable_and_safe() {
        assert_eq!(stem_of("https://a.com/photos/hero-1.jpg?w=2"), "hero-1");
        assert_eq!(stem_of("https://a.com/"), "image");
        assert_eq!(stem_of("https://a.com/%20x%21.png"), "20x21");
    }
}
