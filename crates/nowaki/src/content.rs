//! Content collections: `content/<name>/*.md` (and `*.json` / `*.yaml` data entries), compiled at
//! build time into one JSON file per app that the runtime serves through `getCollection` /
//! `getEntry`. Markdown is rendered here, in Rust; frontmatter (YAML between `---` lines, or TOML
//! between `+++` lines) is parsed here and validated in Node against the schemas in
//! `content/config.ts` (the runtime's content-check.mjs).
//!
//! Output (`<out>/index.json`):
//! `{ "<name>": [ { "slug", "file", "data", "body"?, "html"?, "headings"? } ] }`, entries sorted
//! by slug so builds are reproducible.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use comrak::nodes::NodeValue;
use comrak::{format_html_with_plugins, parse_document, Arena, Options};
use nowaki_core::remote_image::RemoteImages;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, PartialEq)]
pub struct Heading {
    pub depth: u8,
    pub text: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct Entry {
    /// File path under the collection, without extension (`posts/hello` for `posts/hello.md`).
    /// With i18n, without the locale directory (`hello` for `ja/hello.md`).
    pub slug: String,
    /// With i18n: the locale of the collection's first-level directory the entry is in
    /// (`content/blog/ja/hello.md` → `ja`); none for an entry outside a locale directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// The source file, relative to the app root (POSIX separators), for error messages.
    pub file: String,
    /// Frontmatter (Markdown) or the file's contents (data entries), not yet validated.
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headings: Option<Vec<Heading>>,
    /// MDX entries: the compiled module under dist/server (`content/docs/guide.js`), which the
    /// runtime imports for `entry.render()`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// Local images the HTML references through placeholders (`IMAGE_REF`), filled in by
    /// `collect` once every image is built.
    #[serde(skip)]
    pub image_refs: Vec<ImageRef>,
}

/// One Markdown image to turn into a `<picture>` (see `collect`).
#[derive(Debug, Clone, PartialEq)]
pub struct ImageRef {
    /// The image file (for a remote image, its cached download, set by `fill_images`).
    pub abs: PathBuf,
    /// A remote image `images.remotePatterns` allows: its URL.
    pub remote: Option<String>,
    pub alt: String,
    pub title: String,
}

/// The placeholder an image stands as in an entry's HTML until its set is built.
fn image_ref_placeholder(i: usize) -> String {
    format!("<nowaki-image-ref data-i=\"{i}\"></nowaki-image-ref>")
}

/// Whether the app has a `content/` directory with a config (the feature is off otherwise).
pub fn enabled(root: &Path) -> bool {
    let dir = root.join("content");
    ["config.ts", "config.js", "config.mjs", "config.mts"]
        .iter()
        .any(|f| dir.join(f).is_file())
}

/// Where a Markdown entry's local images (`![alt](./hero.jpg)`) go: `nowaki dev` points them at
/// `/__nowaki/image` (encoded on request); a build writes the variants into `dist/client`.
#[derive(Clone)]
pub enum Images {
    Dev,
    Build(PathBuf),
}

/// Reads every collection under `content/`. Each sub-directory is a collection; files directly in
/// `content/` (the config) are not entries. With i18n `locales`, a collection's first-level directory named after one is the entries'
/// `locale`, and not part of their slugs.
pub fn collect(
    root: &Path,
    images: &Images,
    locales: &[String],
) -> Result<BTreeMap<String, Vec<Entry>>> {
    collect_with(
        root,
        images,
        crate::remote_images::current().as_deref(),
        locales,
    )
}

/// [`collect`] with the remote image settings (None: remote images stay plain `<img>`).
fn collect_with(
    root: &Path,
    images: &Images,
    remote: Option<&RemoteImages>,
    locales: &[String],
) -> Result<BTreeMap<String, Vec<Entry>>> {
    let dir = root.join("content");
    let mut out = BTreeMap::new();
    let Ok(read) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    let mut names: Vec<PathBuf> = read
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    names.sort();
    for coll in names {
        let Some(name) = coll
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        let mut files = Vec::new();
        walk(&coll, &mut files);
        let mut entries = Vec::new();
        // Entries are independent: parsed and rendered in parallel (order is restored by the sort).
        use rayon::prelude::*;
        let read: Vec<Result<Option<Entry>>> = files
            .par_iter()
            .map(|path| read_entry(root, &coll, path, remote, locales))
            .collect();
        for e in read {
            if let Some(e) = e? {
                entries.push(e);
            }
        }
        entries.sort_by(|a, b| (&a.slug, &a.locale).cmp(&(&b.slug, &b.locale)));
        for w in entries.windows(2) {
            if w[0].slug == w[1].slug && w[0].locale == w[1].locale {
                return Err(anyhow!(
                    "content/{name}: two entries have the slug \"{}\" ({} and {})",
                    w[0].slug,
                    w[0].file,
                    w[1].file
                ));
            }
        }
        out.insert(name, entries);
    }
    fill_images(root, &mut out, images, remote)?;
    Ok(out)
}

/// Writes `<out_dir>/index.json`. Returns the number of entries.
pub fn write(root: &Path, out_dir: &Path, images: &Images, locales: &[String]) -> Result<usize> {
    let all = collect(root, images, locales)?;
    let n = all.values().map(Vec::len).sum();
    std::fs::create_dir_all(out_dir)?;
    std::fs::write(out_dir.join("index.json"), serde_json::to_string(&all)?)?;
    Ok(n)
}

/// `nowaki build` / `prerender`: writes `dist/server/content/index.json` (content/config is
/// compiled with the other server modules) and validates every entry in Node. Fails the build on
/// an invalid entry, listing each one.
/// `config` is nowaki.config as the plugin host read it (its i18n locales split the entries).
pub fn build(root: &Path, dist: &Path, config: &Value) -> Result<()> {
    if !enabled(root) {
        return Ok(());
    }
    let n = write(
        root,
        &dist.join("server/content"),
        &Images::Build(dist.join("client")),
        &locales(config.get("routing")),
    )?;
    let script = root.join("node_modules/@nowaki-dev/runtime/server/content-check.mjs");
    if !script.exists() {
        return Err(anyhow!("content collections need @nowaki-dev/runtime 0.16 or newer (server/content-check.mjs not found)"));
    }
    let out = std::process::Command::new("node")
        .arg(&script)
        .arg(dist.join("server"))
        .current_dir(root)
        .output()
        .context("failed to run node for the content check")?;
    if !out.status.success() {
        eprint!("{}", String::from_utf8_lossy(&out.stderr));
        return Err(anyhow!(
            "content collections have invalid entries (listed above)"
        ));
    }
    println!("[nowaki] content: {n} entries checked");
    Ok(())
}

/// The i18n locales of a routing config (`dist/server/routing.json`, `.nowaki/routing.json`, or
/// `routing` from the plugin host's config); empty without i18n.
pub fn locales(routing: Option<&Value>) -> Vec<String> {
    routing
        .and_then(|r| r.pointer("/i18n/locales"))
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A slug's locale directory, when it starts with one of `locales` (and has more after it).
fn split_locale(slug: String, locales: &[String]) -> (Option<String>, String) {
    match slug.split_once('/') {
        Some((first, rest)) if !rest.is_empty() && locales.iter().any(|l| l == first) => {
            (Some(first.to_string()), rest.to_string())
        }
        _ => (None, slug),
    }
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = read.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        let hidden = p
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with('.') || n.starts_with('_'));
        if hidden {
            continue;
        }
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn read_entry(
    root: &Path,
    coll: &Path,
    path: &Path,
    remote: Option<&RemoteImages>,
    locales: &[String],
) -> Result<Option<Entry>> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let file = rel(root, path);
    let (locale, slug) = split_locale(
        {
            let r = rel(coll, path);
            r.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(r)
        },
        locales,
    );
    let text = || std::fs::read_to_string(path).with_context(|| format!("failed to read {file}"));
    let mut entry = match ext {
        "md" | "markdown" => {
            let src = text()?;
            let (front, body) = split_frontmatter(&src);
            let data = frontmatter_data(&file, front)?;
            let dir = path.parent().unwrap_or(coll);
            // Images are only recorded here; `collect` builds each file once, after every entry
            // is read (building inside this parallel read could wait on itself, see collect).
            let mut image_refs = Vec::new();
            let mut image = |url: &str, alt: &str, title: &str| -> Result<Option<String>> {
                let (abs, remote_url) = match remote_image_url(&file, url, remote) {
                    Some(u) => (PathBuf::new(), Some(u)),
                    None => match local_image_path(dir, url)? {
                        Some(abs) => (abs, None),
                        None => return Ok(None),
                    },
                };
                image_refs.push(ImageRef {
                    abs,
                    remote: remote_url,
                    alt: alt.to_string(),
                    title: title.to_string(),
                });
                Ok(Some(image_ref_placeholder(image_refs.len() - 1)))
            };
            let (html, headings) =
                render_markdown_with(body, &mut image).map_err(|e| anyhow!("{file}: {e:#}"))?;
            Entry {
                locale: None,
                slug,
                file,
                data,
                body: Some(body.to_string()),
                html: Some(html),
                headings: Some(headings),
                module: None,
                image_refs,
            }
        }
        "mdx" => {
            let src = text()?;
            let (front, body) = split_frontmatter(&src);
            let data = frontmatter_data(&file, front)?;
            let headings = nowaki_core::mdx::headings(body)
                .map_err(|e| anyhow!("{file}: {e:#}"))?
                .into_iter()
                .map(|h| Heading {
                    depth: h.depth,
                    text: h.text,
                    id: h.id,
                })
                .collect();
            let module = file.rsplit_once('.').map(|(stem, _)| format!("{stem}.js"));
            Entry {
                locale: None,
                slug,
                file,
                data,
                body: Some(body.to_string()),
                html: None,
                headings: Some(headings),
                module,
                image_refs: Vec::new(),
            }
        }
        // Markdoc: the plugin compiles the file into a module (its `headings` export is what
        // `render()` returns; Rust can't run Markdoc, so the entry itself has none).
        "mdoc" => {
            let src = text()?;
            let (front, body) = split_frontmatter(&src);
            let data = frontmatter_data(&file, front)?;
            let module = file.rsplit_once('.').map(|(stem, _)| format!("{stem}.js"));
            Entry {
                locale: None,
                slug,
                file,
                data,
                body: Some(body.to_string()),
                html: None,
                headings: None,
                module,
                image_refs: Vec::new(),
            }
        }
        "json" => Entry {
            locale: None,
            data: serde_json::from_str(&text()?).map_err(|e| anyhow!("{file}: {e}"))?,
            slug,
            file,
            body: None,
            html: None,
            headings: None,
            module: None,
            image_refs: Vec::new(),
        },
        "yaml" | "yml" => Entry {
            locale: None,
            data: yaml_to_json(&text()?).map_err(|e| anyhow!("{file}: {e}"))?,
            slug,
            file,
            body: None,
            html: None,
            headings: None,
            module: None,
            image_refs: Vec::new(),
        },
        _ => return Ok(None),
    };
    entry.locale = locale;
    Ok(Some(entry))
}

/// A Markdown / MDX entry's frontmatter, by its fence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Frontmatter<'a> {
    /// `---` … `---`
    Yaml(&'a str),
    /// `+++` … `+++` (Hugo-style)
    Toml(&'a str),
}

/// `---\n<yaml>\n---\n<body>` or `+++\n<toml>\n+++\n<body>`. Only a first line of exactly `---`
/// or `+++` (a trailing `\r` is allowed) opens frontmatter, and the same line closes it; without
/// one, or without the closing line, the whole file is the body.
pub fn split_frontmatter(src: &str) -> (Option<Frontmatter<'_>>, &str) {
    let s = src.strip_prefix('\u{feff}').unwrap_or(src);
    let Some((first, rest)) = s.split_once('\n') else {
        return (None, s);
    };
    let fence = first.strip_suffix('\r').unwrap_or(first);
    if fence != "---" && fence != "+++" {
        return (None, s);
    }
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == fence {
            let front = &rest[..offset];
            let body = &rest[offset + line.len()..];
            let front = if fence == "---" {
                Frontmatter::Yaml(front)
            } else {
                Frontmatter::Toml(front)
            };
            return (Some(front), body);
        }
        offset += line.len();
    }
    (None, s) // no closing fence: not frontmatter
}

/// An entry's frontmatter as JSON (an empty object without any). Errors name the file, and for
/// TOML the line in the file (`content/blog/x.md:3: frontmatter: …`).
fn frontmatter_data(file: &str, front: Option<Frontmatter<'_>>) -> Result<Value> {
    match front {
        None => Ok(Value::Object(Default::default())),
        Some(Frontmatter::Yaml(y)) => {
            yaml_to_json(y).map_err(|e| anyhow!("{file}: frontmatter: {e}"))
        }
        Some(Frontmatter::Toml(t)) => toml_to_json(t).map_err(|e| match e.line {
            // The opening `+++` is line 1 of the file.
            Some(line) => anyhow!("{file}:{}: frontmatter: {}", line + 1, e.message),
            None => anyhow!("{file}: frontmatter: {}", e.message),
        }),
    }
}

/// YAML → JSON value. Dates stay strings (`2026-11-05`); a schema can coerce them.
pub fn yaml_to_json(y: &str) -> std::result::Result<Value, String> {
    if y.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    let v: Value = serde_saphyr::from_str(y).map_err(|e| e.to_string())?;
    match v {
        Value::Object(_) => Ok(v),
        Value::Null => Ok(Value::Object(Default::default())),
        _ => Err("frontmatter must be a mapping (key: value)".into()),
    }
}

/// A TOML frontmatter error, with its 1-based line within the TOML when known.
#[derive(Debug)]
pub struct TomlError {
    pub line: Option<usize>,
    pub message: String,
}

/// TOML → JSON value, mapped like YAML's: tables become objects (keys in written order), arrays
/// arrays, and datetimes ISO 8601 / RFC 3339 strings, as YAML dates stay strings (`2026-11-05`,
/// `2026-11-05T10:00:00Z`, `10:00:00`); a schema can coerce them (`z.coerce.date()`). A TOML
/// datetime written with a space (`2026-11-05 10:00:00Z`) comes out with a `T`. NaN and infinity
/// have no JSON form and are an error.
pub fn toml_to_json(t: &str) -> std::result::Result<Value, TomlError> {
    let table: toml::Table = toml::from_str(t).map_err(|e| TomlError {
        line: e
            .span()
            .map(|s| t[..s.start.min(t.len())].matches('\n').count() + 1),
        message: e.message().trim_end().to_string(),
    })?;
    toml_table(table, "").map_err(|message| TomlError {
        line: None,
        message,
    })
}

fn toml_table(t: toml::Table, path: &str) -> std::result::Result<Value, String> {
    let mut map = serde_json::Map::with_capacity(t.len());
    for (k, v) in t {
        let p = if path.is_empty() {
            k.clone()
        } else {
            format!("{path}.{k}")
        };
        map.insert(k, toml_value(v, &p)?);
    }
    Ok(Value::Object(map))
}

fn toml_value(v: toml::Value, path: &str) -> std::result::Result<Value, String> {
    Ok(match v {
        toml::Value::String(s) => Value::String(s),
        toml::Value::Integer(i) => Value::from(i),
        toml::Value::Float(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| format!("{path}: {f} has no JSON equivalent"))?,
        toml::Value::Boolean(b) => Value::Bool(b),
        toml::Value::Datetime(d) => Value::String(d.to_string()),
        toml::Value::Array(a) => Value::Array(
            a.into_iter()
                .enumerate()
                .map(|(i, v)| toml_value(v, &format!("{path}[{i}]")))
                .collect::<std::result::Result<_, _>>()?,
        ),
        toml::Value::Table(t) => toml_table(t, path)?,
    })
}

fn markdown_options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    o.extension.autolink = true;
    o.extension.header_id_prefix = Some(String::new());
    // Content comes from the app's own repository, like its components: raw HTML is allowed.
    o.render.r#unsafe = true;
    o
}

/// Fenced code blocks with a language (```rust) are highlighted at build time (see
/// `nowaki_core::highlight`, shared with MDX).
fn highlighter() -> &'static nowaki_core::highlight::CachedAdapter {
    nowaki_core::highlight::adapter()
}

/// The file a Markdown image with a relative URL (`./hero.jpg`, `../img/a.png`) points at, to
/// go through the same pipeline as `?image`. None leaves the image as Markdown wrote it: remote
/// and root-relative URLs (`/logo.svg`, from public/). A relative path that isn't an image file
/// is an error.
fn local_image_path(dir: &Path, url: &str) -> Result<Option<PathBuf>> {
    if url.is_empty()
        || url.starts_with('/')
        || url.starts_with('#')
        || url.contains("://")
        || url.starts_with("data:")
    {
        return Ok(None);
    }
    let path_part = url.split(['?', '#']).next().unwrap_or(url);
    let abs = dir.join(percent_decode(path_part));
    if !abs.is_file() || !nowaki_core::is_asset(&abs) {
        return Err(anyhow!(
            "image {url} not found (paths are relative to the entry)"
        ));
    }
    // `../../hero.jpg` → the real path, so dev URLs and file names don't carry `..`.
    Ok(Some(dunce::canonicalize(&abs).unwrap_or(abs)))
}

/// A remote Markdown image (`![alt](https://…)`) that `images.remotePatterns` allows: its URL,
/// to go through the image pipeline. Other remote images stay as Markdown wrote them, with a
/// warning when remote patterns are configured.
fn remote_image_url(file: &str, url: &str, remote: Option<&RemoteImages>) -> Option<String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let remote = remote?;
    if remote.allowed(url) {
        return Some(url.to_string());
    }
    if !remote.patterns().is_empty() {
        eprintln!(
            "[nowaki] warning: {file}: remote image {url} doesn't match images.remotePatterns; it stays a plain <img>"
        );
    }
    None
}

/// The image set for a file: dev URLs, or the variants written into dist/client.
fn image_set(root: &Path, abs: &Path, images: &Images) -> Result<nowaki_core::image::ImageSet> {
    let q = nowaki_core::image::ImageQuery::default();
    match images {
        Images::Dev => nowaki_core::image::dev_set(root, abs, &q),
        Images::Build(client_dir) => {
            nowaki_core::image::build_set(root, abs, &q, |stem, w, ext, bytes| {
                let base = crate::site::asset_base();
                nowaki_core::image::write_variant_at(client_dir, base, stem, w, ext, bytes)
            })
        }
    }
}

/// Builds every image the entries reference, each file once and in parallel, then swaps each
/// entry's placeholders for its `<picture>`. This runs after the entries are read, outside that
/// parallel loop: building an image (its own parallel variants) while other entries wait on the
/// same file deadlocked rayon, whose waiting worker picks up one of those entries.
fn fill_images(
    root: &Path,
    all: &mut BTreeMap<String, Vec<Entry>>,
    images: &Images,
    remote: Option<&RemoteImages>,
) -> Result<()> {
    use rayon::prelude::*;
    // Remote images first, downloading every miss in one go.
    let mut urls: Vec<String> = all
        .values()
        .flatten()
        .flat_map(|e| e.image_refs.iter().filter_map(|r| r.remote.clone()))
        .collect();
    urls.sort();
    urls.dedup();
    if let (Some(remote), false) = (remote, urls.is_empty()) {
        let mut files = std::collections::HashMap::new();
        for (url, file) in urls.iter().zip(remote.ensure(&urls)) {
            files.insert(url.clone(), file?);
        }
        for r in all
            .values_mut()
            .flatten()
            .flat_map(|e| e.image_refs.iter_mut())
        {
            if let Some(url) = &r.remote {
                r.abs = files[url].clone();
            }
        }
    }
    let mut files: Vec<PathBuf> = all
        .values()
        .flatten()
        .flat_map(|e| e.image_refs.iter().map(|r| r.abs.clone()))
        .collect();
    files.sort();
    files.dedup();
    if files.is_empty() {
        return Ok(());
    }
    let built: Vec<(PathBuf, Result<nowaki_core::image::ImageSet>)> = files
        .into_par_iter()
        .map(|f| {
            let set = image_set(root, &f, images);
            (f, set)
        })
        .collect();
    let mut sets = std::collections::HashMap::new();
    for (f, set) in built {
        sets.insert(
            f.clone(),
            set.map_err(|e| anyhow!("{}: {e:#}", f.display()))?,
        );
    }
    for entry in all.values_mut().flatten() {
        let Some(html) = entry.html.as_mut() else {
            continue;
        };
        for (i, r) in entry.image_refs.iter().enumerate() {
            let picture = nowaki_core::image::picture_html(&sets[&r.abs], &r.alt, Some(&r.title));
            *html = html.replacen(&image_ref_placeholder(i), &picture, 1);
        }
        entry.image_refs.clear();
    }
    Ok(())
}

/// `%20` → ` ` (Markdown URLs are often percent-encoded); a malformed escape stays as written.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%')
            .then(|| b.get(i + 1..i + 3))
            .flatten()
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(v) => {
                out.push(v);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Renders Markdown to HTML and lists its headings (with the same ids as the anchors comrak adds).
/// Images stay `<img>`; entries go through `render_markdown_with`, which turns local ones into
/// responsive `<picture>`s.
#[cfg(test)]
fn render_markdown(md: &str) -> (String, Vec<Heading>) {
    render_markdown_with(md, &mut |_, _, _| Ok(None)).expect("no image callback errors")
}

/// `image(url, alt, title)`: the HTML for a Markdown image, or None to keep it as written.
pub type ImageHtml<'a> = dyn FnMut(&str, &str, &str) -> Result<Option<String>> + 'a;

/// `render_markdown`, with `image` giving the HTML for each image.
pub fn render_markdown_with(md: &str, image: &mut ImageHtml) -> Result<(String, Vec<Heading>)> {
    let arena = Arena::new();
    let options = markdown_options();
    let doc = parse_document(&arena, md, &options);
    // Images first: the node becomes raw HTML (render.unsafe is on), its alt-text children go.
    let image_nodes: Vec<_> = doc
        .descendants()
        .filter(|n| matches!(n.data.borrow().value, NodeValue::Image(_)))
        .collect();
    for node in image_nodes {
        let (url, title) = match &node.data.borrow().value {
            NodeValue::Image(link) => (link.url.clone(), link.title.clone()),
            _ => continue,
        };
        let mut alt = String::new();
        for d in node.descendants() {
            match &d.data.borrow().value {
                NodeValue::Text(t) => alt.push_str(t),
                NodeValue::Code(c) => alt.push_str(&c.literal),
                _ => {}
            }
        }
        if let Some(html) = image(&url, &alt, &title)? {
            let children: Vec<_> = node.children().collect();
            for c in children {
                c.detach();
            }
            node.data.borrow_mut().value = NodeValue::HtmlInline(html);
        }
    }
    let mut headings = Vec::new();
    let mut anchorizer = comrak::Anchorizer::new();
    for node in doc.descendants() {
        let depth = match &node.data.borrow().value {
            NodeValue::Heading(h) => h.level,
            _ => continue,
        };
        // The text comrak anchorizes for the HTML id (a soft / hard break counts as a space), so
        // the two ids agree.
        let text = node.collect_text();
        let id = anchorizer.anchorize(&text);
        headings.push(Heading { depth, text, id });
    }
    let mut plugins = comrak::options::Plugins::default();
    // Loading the syntax set takes a moment: only when the entry has a code fence.
    if md.contains("```") || md.contains("~~~") {
        plugins.render.codefence_syntax_highlighter = Some(highlighter());
    }
    let mut html = String::new();
    format_html_with_plugins(doc, &options, &mut html, &plugins).expect("writing to a String");
    Ok((html, headings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn splits_yaml_frontmatter() {
        let (f, b) = split_frontmatter("---\ntitle: Hi\n---\n# Body\n");
        assert_eq!(f, Some(Frontmatter::Yaml("title: Hi\n")));
        assert_eq!(b, "# Body\n");
        let (f, b) = split_frontmatter("# No frontmatter\n");
        assert_eq!(f, None);
        assert_eq!(b, "# No frontmatter\n");
        // An unclosed fence is body text, not frontmatter.
        assert_eq!(split_frontmatter("---\ntitle: x\n").0, None);
        // CRLF and a BOM.
        let (f, b) = split_frontmatter("\u{feff}---\r\ntitle: Hi\r\n---\r\nbody");
        assert_eq!(f, Some(Frontmatter::Yaml("title: Hi\r\n")));
        assert_eq!(b, "body");
    }

    #[test]
    fn splits_toml_frontmatter() {
        let (f, b) = split_frontmatter("+++\ntitle = \"Hi\"\n+++\n# Body\n");
        assert_eq!(f, Some(Frontmatter::Toml("title = \"Hi\"\n")));
        assert_eq!(b, "# Body\n");
        // CRLF and a BOM.
        let (f, b) = split_frontmatter("\u{feff}+++\r\ntitle = \"Hi\"\r\n+++\r\nbody\r\n");
        assert_eq!(f, Some(Frontmatter::Toml("title = \"Hi\"\r\n")));
        assert_eq!(b, "body\r\n");
        // `+++` later in the body is body text.
        let src = "+++\na = 1\n+++\nText\n+++\nmore\n+++\n";
        assert_eq!(
            split_frontmatter(src),
            (Some(Frontmatter::Toml("a = 1\n")), "Text\n+++\nmore\n+++\n")
        );
        let src = "# Title\n\n+++\na = 1\n+++\n";
        assert_eq!(split_frontmatter(src), (None, src));
        // Only an exact `+++` first line opens it, and only the same fence closes it.
        for src in [
            "++++\na = 1\n++++\n",
            "+++ \na = 1\n+++\n",
            " +++\na = 1\n+++\n",
            "+++toml\na = 1\n+++\n",
            "+++\na = 1\n---\n",
            "---\na: 1\n+++\n",
            "+++\na = 1\n", // unclosed
        ] {
            assert_eq!(split_frontmatter(src), (None, src), "{src:?}");
        }
    }

    #[test]
    fn toml_maps_like_yaml() {
        let v = toml_to_json(
            "title = \"Hello\"\ndate = 2026-11-05\ntags = [\"a\", \"b\"]\ndraft = false\norder = 2\nscore = 1.5\n[author]\nname = \"Tettu\"\n",
        )
        .unwrap();
        let y = yaml_to_json(
            "title: Hello\ndate: 2026-11-05\ntags: [a, b]\ndraft: false\norder: 2\nscore: 1.5\nauthor:\n  name: Tettu\n",
        )
        .unwrap();
        assert_eq!(v, y);
        // Keys keep the order they were written in, as YAML's do.
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            ["title", "date", "tags", "draft", "order", "score", "author"]
        );
        assert_eq!(toml_to_json("").unwrap(), serde_json::json!({}));
        let nan = toml_to_json("[x]\ny = nan\n").unwrap_err();
        assert_eq!(nan.message, "x.y: NaN has no JSON equivalent");
    }

    #[test]
    fn toml_datetimes_become_iso_strings() {
        let v = toml_to_json(
            "d = 2026-11-05\nodt = 2026-11-05T10:30:00Z\noff = 2026-11-05 10:30:00.5+09:00\nldt = 2026-11-05T10:30:00\nt = 10:30:00\nlist = [2026-01-01]\n",
        )
        .unwrap();
        assert_eq!(v["d"], "2026-11-05");
        assert_eq!(v["odt"], "2026-11-05T10:30:00Z");
        assert_eq!(v["off"], "2026-11-05T10:30:00.5+09:00");
        assert_eq!(v["ldt"], "2026-11-05T10:30:00");
        assert_eq!(v["t"], "10:30:00");
        assert_eq!(v["list"][0], "2026-01-01");
        // The same strings YAML gives for the same dates.
        let y = yaml_to_json("d: 2026-11-05\nodt: 2026-11-05T10:30:00Z\n").unwrap();
        assert_eq!((&v["d"], &v["odt"]), (&y["d"], &y["odt"]));
    }

    #[test]
    fn a_toml_syntax_error_names_the_file_and_line() {
        let err = frontmatter_data(
            "content/blog/x.md",
            Some(Frontmatter::Toml("title = \"ok\"\n\norder = = 1\n")),
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.starts_with("content/blog/x.md:4: frontmatter: "),
            "{err}"
        );
        // Through collect, from a CRLF file: the bad date is on line 3 (the fence is line 1).
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/blog")).unwrap();
        std::fs::write(
            r.join("content/blog/x.md"),
            "+++\r\ntitle = \"x\"\r\ndate = 2026-13-45\r\n+++\r\nbody\r\n",
        )
        .unwrap();
        let err = collect(r, &Images::Dev, &[]).unwrap_err().to_string();
        assert!(err.contains("content/blog/x.md:3: frontmatter: "), "{err}");
    }

    #[test]
    fn toml_entries_collect_like_yaml_ones() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/blog")).unwrap();
        std::fs::write(
            r.join("content/blog/a.md"),
            "+++\r\ntitle = \"A\"\r\ndate = 2026-11-05\r\n+++\r\n# A\r\n\r\n+++\r\nnot = \"frontmatter\"\r\n+++\r\n",
        )
        .unwrap();
        std::fs::write(
            r.join("content/blog/b.mdx"),
            "+++\ntitle = \"B\"\n+++\n# B\n",
        )
        .unwrap();
        let all = collect(r, &Images::Dev, &[]).unwrap();
        let [a, b] = &all["blog"][..] else {
            panic!("{:?}", all["blog"]);
        };
        assert_eq!(
            a.data,
            serde_json::json!({ "title": "A", "date": "2026-11-05" })
        );
        let body = a.body.as_deref().unwrap();
        assert!(
            body.contains("+++\r\nnot = \"frontmatter\"\r\n+++"),
            "{body}"
        );
        assert!(!body.contains("title"), "{body}");
        assert_eq!(a.headings.as_ref().unwrap()[0].id, "a");
        assert_eq!(b.data, serde_json::json!({ "title": "B" }));
        assert_eq!(b.headings.as_ref().unwrap()[0].text, "B");
        assert_eq!(b.module.as_deref(), Some("content/blog/b.js"));
    }

    #[test]
    fn yaml_becomes_json_and_rejects_non_mappings() {
        let v =
            yaml_to_json("title: Hello\ndate: 2026-11-05\ntags: [a, b]\ndraft: false\n").unwrap();
        assert_eq!(v["title"], "Hello");
        assert_eq!(v["date"], "2026-11-05");
        assert_eq!(v["tags"][1], "b");
        assert_eq!(v["draft"], false);
        assert!(yaml_to_json("- a\n- b\n").is_err());
        assert!(yaml_to_json("title: [unclosed\n").is_err());
        assert_eq!(yaml_to_json("").unwrap(), serde_json::json!({}));
    }

    #[test]
    fn renders_gfm_and_lists_headings_with_their_anchor_ids() {
        let (html, headings) = render_markdown(
            "# Hello `world`\n\nText with ~~old~~ and a [link](https://x.dev).\n\n## Setup\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Setup\n\n- [x] done\n",
        );
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("<del>old</del>"), "{html}");
        assert!(html.contains("type=\"checkbox\""), "{html}");
        assert_eq!(
            headings,
            vec![
                Heading {
                    depth: 1,
                    text: "Hello world".into(),
                    id: "hello-world".into()
                },
                Heading {
                    depth: 2,
                    text: "Setup".into(),
                    id: "setup".into()
                },
                Heading {
                    depth: 2,
                    text: "Setup".into(),
                    id: "setup-1".into()
                },
            ]
        );
        for h in &headings {
            assert!(
                html.contains(&format!("id=\"{}\"", h.id)),
                "anchor {} missing:\n{html}",
                h.id
            );
        }
    }

    #[test]
    fn local_markdown_images_become_pictures() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("content/docs")).unwrap();
        // examples/hello/hero.jpg is 1200×750.
        let hero = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/hello/hero.jpg");
        std::fs::copy(hero, dir.path().join("content/docs/a b.jpg")).unwrap();
        std::fs::write(
            dir.path().join("content/docs/a.md"),
            "![A *wide* image](./a%20b.jpg \"Caption\")\n\n![logo](/logo.svg) ![remote](https://x.test/a.png)\n",
        )
        .unwrap();
        let client = dir.path().join("dist/client");
        let all = collect(dir.path(), &Images::Build(client.clone()), &[]).unwrap();
        let html = all["docs"][0].html.clone().unwrap();
        assert!(
            html.contains("<picture><source type=\"image/avif\" srcset=\"/_nowaki/a_b-640."),
            "{html}"
        );
        assert!(
            html.contains("width=\"1200\" height=\"750\" alt=\"A wide image\" title=\"Caption\""),
            "{html}"
        );
        assert!(
            html.contains("<img src=\"/logo.svg\" alt=\"logo\""),
            "{html}"
        );
        assert!(html.contains("<img src=\"https://x.test/a.png\""), "{html}");
        assert!(!html.contains("nowaki-image-ref"), "{html}");
        assert!(std::fs::read_dir(&client).unwrap().count() >= 4);

        std::fs::write(dir.path().join("content/docs/b.md"), "![x](./nope.png)\n").unwrap();
        let err = collect(dir.path(), &Images::Build(client), &[])
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("content/docs/b.md") && err.contains("not found"),
            "{err}"
        );
    }

    #[test]
    fn many_entries_sharing_one_uncached_image_build_it_once() {
        // Each entry used to build its image inside the parallel read; with the cache empty, a
        // worker waiting on a photo it was itself building picked up another entry and hung.
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("content/docs");
        std::fs::create_dir_all(&docs).unwrap();
        let hero = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/hello/hero.jpg");
        std::fs::copy(hero, docs.join("shared.jpg")).unwrap();
        for i in 0..64 {
            std::fs::write(
                docs.join(format!("e{i:02}.md")),
                format!("# E{i}\n\n![p](./shared.jpg)\n"),
            )
            .unwrap();
        }
        let all = collect(
            dir.path(),
            &Images::Build(dir.path().join("dist/client")),
            &[],
        )
        .unwrap();
        assert_eq!(all["docs"].len(), 64);
        assert!(all["docs"]
            .iter()
            .all(|e| e.html.as_deref().unwrap().contains("<picture>")));
    }

    #[test]
    fn highlights_fenced_code_with_a_language_at_build_time() {
        let (html, _) =
            render_markdown("```rust\nfn main() { let x = 1; }\n```\n\n```\nplain text\n```\n");
        // TypeScript / TSX come from two-face's syntax set (not in syntect's defaults).
        let (tsx, _) = render_markdown("```tsx\nconst a: number = 1;\n```\n");
        let colors: std::collections::HashSet<&str> = tsx
            .match_indices("color:#")
            .map(|(i, _)| &tsx[i..i + 13])
            .collect();
        assert!(
            colors.len() > 1,
            "tsx should get more than one color:\n{tsx}"
        );
        // Colored spans for the Rust block (keywords get their own style).
        assert!(html.contains("<span style=\"color:"), "{html}");
        assert!(
            html.contains(">fn</span>") || html.contains(">fn </span>"),
            "{html}"
        );
        // A block without a language stays plain, escaped text.
        assert!(html.contains("plain text"), "{html}");
        // Unknown languages don't fail the build.
        let (html, _) = render_markdown("```not-a-language\n<x>\n```\n");
        assert!(html.contains("&lt;x&gt;"), "{html}");
    }

    #[test]
    fn collects_collections_sorted_and_rejects_duplicate_slugs() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/blog/2026")).unwrap();
        std::fs::create_dir_all(r.join("content/authors")).unwrap();
        std::fs::write(r.join("content/config.ts"), "").unwrap();
        std::fs::write(r.join("content/blog/b.md"), "---\ntitle: B\n---\nb").unwrap();
        std::fs::write(r.join("content/blog/2026/a.md"), "---\ntitle: A\n---\n# A").unwrap();
        std::fs::write(r.join("content/blog/_draft.md"), "x").unwrap();
        std::fs::write(r.join("content/blog/notes.txt"), "ignored").unwrap();
        std::fs::write(r.join("content/authors/tettu.json"), "{\"name\":\"Tettu\"}").unwrap();
        assert!(enabled(r));
        let all = collect(r, &Images::Dev, &[]).unwrap();
        let blog: Vec<_> = all["blog"].iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(blog, ["2026/a", "b"]);
        assert_eq!(all["blog"][0].file, "content/blog/2026/a.md");
        assert_eq!(all["blog"][0].headings.as_ref().unwrap()[0].id, "a");
        assert_eq!(all["authors"][0].data["name"], "Tettu");
        assert!(all["authors"][0].html.is_none());

        std::fs::write(r.join("content/blog/b.json"), "{}").unwrap();
        let err = collect(r, &Images::Dev, &[]).unwrap_err().to_string();
        assert!(err.contains("two entries have the slug \"b\""), "{err}");
    }

    #[test]
    fn a_bad_frontmatter_names_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/blog")).unwrap();
        std::fs::write(r.join("content/blog/x.md"), "---\ntitle: [oops\n---\n").unwrap();
        let err = collect(r, &Images::Dev, &[]).unwrap_err().to_string();
        assert!(err.contains("content/blog/x.md: frontmatter"), "{err}");
    }

    #[test]
    fn multi_line_heading_ids_match_the_html_anchors() {
        // A setext heading over two lines (soft break) and one with a hard break.
        let (html, headings) =
            render_markdown("Setext\nline two\n========\n\nHard  \nbreak `code`\n--------\n");
        assert_eq!(headings.len(), 2);
        for h in &headings {
            assert!(
                html.contains(&format!("id=\"{}\"", h.id)),
                "{} in {html}",
                h.id
            );
        }
        assert_eq!(headings[0].id, "setext-line-two");
        assert_eq!(headings[0].text, "Setext line two");
        assert_eq!(headings[1].id, "hard-break-code");
    }

    #[test]
    fn mdoc_entries_are_modules_with_yaml_or_toml_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/docs")).unwrap();
        std::fs::write(
            r.join("content/docs/a.mdoc"),
            "---\ntitle: A\norder: 1\n---\n# A\n\n{% callout %}x{% /callout %}\n",
        )
        .unwrap();
        std::fs::write(
            r.join("content/docs/b.mdoc"),
            "+++\r\ntitle = \"B\"\r\n+++\r\n# B\r\n",
        )
        .unwrap();
        let all = collect(r, &Images::Dev, &[]).unwrap();
        let [a, b] = &all["docs"][..] else {
            panic!("{:?}", all["docs"]);
        };
        assert_eq!(a.data, serde_json::json!({ "title": "A", "order": 1 }));
        assert_eq!(a.module.as_deref(), Some("content/docs/a.js"));
        assert_eq!(
            a.body.as_deref(),
            Some("# A\n\n{% callout %}x{% /callout %}\n")
        );
        assert!(a.html.is_none() && a.headings.is_none());
        assert_eq!(b.data, serde_json::json!({ "title": "B" }));
        assert_eq!(b.module.as_deref(), Some("content/docs/b.js"));
    }

    /// Writes a small PNG for every request, counting fetcher calls.
    struct FakeFetch(std::sync::atomic::AtomicUsize);

    impl nowaki_core::RemoteFetch for FakeFetch {
        fn fetch(
            &self,
            _: &[nowaki_core::RemotePattern],
            reqs: &[nowaki_core::remote_image::RemoteRequest],
        ) -> Vec<Result<()>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            reqs.iter()
                .map(|r| {
                    std::fs::create_dir_all(&r.dir)?;
                    let file = format!("{}.png", r.stem);
                    let png = Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../examples/hello/photo.png");
                    std::fs::copy(png, r.dir.join(&file))?;
                    std::fs::write(
                        r.dir.join("meta.json"),
                        serde_json::json!({ "url": r.url, "file": file }).to_string(),
                    )?;
                    Ok(())
                })
                .collect()
        }
    }

    #[test]
    fn allowed_remote_markdown_images_become_pictures_in_one_fetch() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("content/docs")).unwrap();
        let md = "![a](https://img.test/p/a.png) ![b](https://img.test/p/b.png)\n\n![other](https://other.test/c.png)\n";
        std::fs::write(dir.path().join("content/docs/a.md"), md).unwrap();
        std::fs::write(dir.path().join("content/docs/b.md"), md).unwrap();
        let fetch = Arc::new(FakeFetch(Default::default()));
        let patterns = vec![nowaki_core::RemotePattern {
            protocol: None,
            hostname: "img.test".into(),
            port: None,
            pathname: Some("/p/**".into()),
        }];
        let remote = RemoteImages::new(dir.path().to_path_buf(), patterns, Some(fetch.clone()));
        let client = dir.path().join("dist/client");
        let all = collect_with(dir.path(), &Images::Build(client), Some(&remote), &[]).unwrap();
        assert_eq!(fetch.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        let html = all["docs"][0].html.clone().unwrap();
        assert!(html.contains("srcset=\"/_nowaki/a-256."), "{html}");
        assert!(
            html.contains("width=\"256\" height=\"256\" alt=\"a\""),
            "{html}"
        );
        assert!(
            html.contains("<img src=\"https://other.test/c.png\""),
            "{html}"
        );
        // Cached: no fetch the second time.
        let remote = RemoteImages::new(
            dir.path().to_path_buf(),
            remote.patterns().to_vec(),
            Some(fetch.clone()),
        );
        collect_with(dir.path(), &Images::Dev, Some(&remote), &[]).unwrap();
        assert_eq!(fetch.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_locale_directory_becomes_the_entry_locale() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/blog/ja/2026")).unwrap();
        std::fs::create_dir_all(r.join("content/blog/en")).unwrap();
        std::fs::write(r.join("content/blog/en/hello.md"), "# Hello").unwrap();
        std::fs::write(r.join("content/blog/ja/hello.md"), "# Hi").unwrap();
        std::fs::write(r.join("content/blog/ja/2026/a.md"), "# A").unwrap();
        std::fs::write(r.join("content/blog/shared.md"), "# S").unwrap();
        // Not a configured locale: an ordinary directory.
        std::fs::create_dir_all(r.join("content/blog/fr")).unwrap();
        std::fs::write(r.join("content/blog/fr/x.md"), "# X").unwrap();
        let locales = vec!["en".to_string(), "ja".to_string()];
        let all = collect(r, &Images::Dev, &locales).unwrap();
        let got: Vec<_> = all["blog"]
            .iter()
            .map(|e| (e.slug.as_str(), e.locale.as_deref()))
            .collect();
        assert_eq!(
            got,
            [
                ("2026/a", Some("ja")),
                ("fr/x", None),
                ("hello", Some("en")),
                ("hello", Some("ja")),
                ("shared", None)
            ]
        );
        let json = serde_json::to_value(&all["blog"][0]).unwrap();
        assert_eq!(json["locale"], "ja");
        assert!(serde_json::to_value(&all["blog"][1])
            .unwrap()
            .get("locale")
            .is_none());
        // Without i18n the directory stays in the slug.
        let plain = collect(r, &Images::Dev, &[]).unwrap();
        assert!(plain["blog"].iter().any(|e| e.slug == "ja/hello"));
        // The same slug twice in one locale is still an error.
        std::fs::write(r.join("content/blog/ja/hello.json"), "{}").unwrap();
        let err = collect(r, &Images::Dev, &locales).unwrap_err().to_string();
        assert!(err.contains("two entries have the slug \"hello\""), "{err}");
        assert_eq!(
            locales_of(r#"{"i18n":{"locales":["en","ja"],"defaultLocale":"en"}}"#),
            ["en", "ja"]
        );
        assert!(locales_of("{}").is_empty());
    }

    fn locales_of(json: &str) -> Vec<String> {
        locales(Some(&serde_json::from_str(json).unwrap()))
    }
}
