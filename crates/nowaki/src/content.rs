//! Content collections: `content/<name>/*.md` (and `*.json` / `*.yaml` data entries), compiled at
//! build time into one JSON file per app that the runtime serves through `getCollection` /
//! `getEntry`. Markdown is rendered here, in Rust; frontmatter is parsed here and validated in
//! Node against the schemas in `content/config.ts` (the runtime's content-check.mjs).
//!
//! Output (`<out>/index.json`):
//! `{ "<name>": [ { "slug", "file", "data", "body"?, "html"?, "headings"? } ] }`, entries sorted
//! by slug so builds are reproducible.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use comrak::nodes::NodeValue;
use comrak::{format_html_with_plugins, parse_document, Arena, Options};
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
    pub slug: String,
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
    pub abs: PathBuf,
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

/// Reads every collection under `content/`. Each sub-directory is a collection; files directly in
/// `content/` (the config) are not entries.
/// Where a Markdown entry's local images (`![alt](./hero.jpg)`) go: `nowaki dev` points them at
/// `/__nowaki/image` (encoded on request); a build writes the variants into `dist/client`.
#[derive(Clone)]
pub enum Images {
    Dev,
    Build(PathBuf),
}

pub fn collect(root: &Path, images: &Images) -> Result<BTreeMap<String, Vec<Entry>>> {
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
            .map(|path| read_entry(root, &coll, path))
            .collect();
        for e in read {
            if let Some(e) = e? {
                entries.push(e);
            }
        }
        entries.sort_by(|a, b| a.slug.cmp(&b.slug));
        for w in entries.windows(2) {
            if w[0].slug == w[1].slug {
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
    fill_images(root, &mut out, images)?;
    Ok(out)
}

/// Writes `<out_dir>/index.json`. Returns the number of entries.
pub fn write(root: &Path, out_dir: &Path, images: &Images) -> Result<usize> {
    let all = collect(root, images)?;
    let n = all.values().map(Vec::len).sum();
    std::fs::create_dir_all(out_dir)?;
    std::fs::write(out_dir.join("index.json"), serde_json::to_string(&all)?)?;
    Ok(n)
}

/// `nowaki build` / `prerender`: writes `dist/server/content/index.json` (content/config is
/// compiled with the other server modules) and validates every entry in Node. Fails the build on
/// an invalid entry, listing each one.
pub fn build(root: &Path, dist: &Path) -> Result<()> {
    if !enabled(root) {
        return Ok(());
    }
    let n = write(
        root,
        &dist.join("server/content"),
        &Images::Build(dist.join("client")),
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

fn read_entry(root: &Path, coll: &Path, path: &Path) -> Result<Option<Entry>> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let file = rel(root, path);
    let slug = {
        let r = rel(coll, path);
        r.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(r)
    };
    let text = || std::fs::read_to_string(path).with_context(|| format!("failed to read {file}"));
    Ok(Some(match ext {
        "md" | "markdown" => {
            let src = text()?;
            let (front, body) = split_frontmatter(&src);
            let data = match front {
                Some(y) => yaml_to_json(y).map_err(|e| anyhow!("{file}: frontmatter: {e}"))?,
                None => Value::Object(Default::default()),
            };
            let dir = path.parent().unwrap_or(coll);
            // Images are only recorded here; `collect` builds each file once, after every entry
            // is read (building inside this parallel read could wait on itself, see collect).
            let mut image_refs = Vec::new();
            let mut image = |url: &str, alt: &str, title: &str| -> Result<Option<String>> {
                let Some(abs) = local_image_path(dir, url)? else {
                    return Ok(None);
                };
                image_refs.push(ImageRef {
                    abs,
                    alt: alt.to_string(),
                    title: title.to_string(),
                });
                Ok(Some(image_ref_placeholder(image_refs.len() - 1)))
            };
            let (html, headings) =
                render_markdown_with(body, &mut image).map_err(|e| anyhow!("{file}: {e:#}"))?;
            Entry {
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
            let data = match front {
                Some(y) => yaml_to_json(y).map_err(|e| anyhow!("{file}: frontmatter: {e}"))?,
                None => Value::Object(Default::default()),
            };
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
        "json" => Entry {
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
    }))
}

/// `---\n<yaml>\n---\n<body>`. Without a leading `---` line, the whole file is the body.
pub fn split_frontmatter(src: &str) -> (Option<&str>, &str) {
    let s = src.strip_prefix('\u{feff}').unwrap_or(src);
    let Some(rest) = s
        .strip_prefix("---\n")
        .or_else(|| s.strip_prefix("---\r\n"))
    else {
        return (None, s);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let yaml = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (Some(yaml), body);
        }
        offset += line.len();
    }
    (None, s) // no closing fence: not frontmatter
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

/// The image set for a file: dev URLs, or the variants written into dist/client.
fn image_set(root: &Path, abs: &Path, images: &Images) -> Result<nowaki_core::image::ImageSet> {
    let q = nowaki_core::image::ImageQuery::default();
    match images {
        Images::Dev => nowaki_core::image::dev_set(root, abs, &q),
        Images::Build(client_dir) => {
            nowaki_core::image::build_set(root, abs, &q, |stem, w, ext, bytes| {
                nowaki_core::image::write_variant(client_dir, stem, w, ext, bytes)
            })
        }
    }
}

/// Builds every image the entries reference, each file once and in parallel, then swaps each
/// entry's placeholders for its `<picture>`. This runs after the entries are read, outside that
/// parallel loop: building an image (its own parallel variants) while other entries wait on the
/// same file deadlocked rayon, whose waiting worker picks up one of those entries.
fn fill_images(root: &Path, all: &mut BTreeMap<String, Vec<Entry>>, images: &Images) -> Result<()> {
    use rayon::prelude::*;
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
        let mut text = String::new();
        for d in node.descendants() {
            match &d.data.borrow().value {
                NodeValue::Text(t) => text.push_str(t),
                NodeValue::Code(c) => text.push_str(&c.literal),
                _ => {}
            }
        }
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

    #[test]
    fn splits_yaml_frontmatter() {
        let (f, b) = split_frontmatter("---\ntitle: Hi\n---\n# Body\n");
        assert_eq!(f, Some("title: Hi\n"));
        assert_eq!(b, "# Body\n");
        let (f, b) = split_frontmatter("# No frontmatter\n");
        assert_eq!(f, None);
        assert_eq!(b, "# No frontmatter\n");
        // An unclosed fence is body text, not frontmatter.
        assert_eq!(split_frontmatter("---\ntitle: x\n").0, None);
        // CRLF and a BOM.
        let (f, b) = split_frontmatter("\u{feff}---\r\ntitle: Hi\r\n---\r\nbody");
        assert_eq!(f, Some("title: Hi\r\n"));
        assert_eq!(b, "body");
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
        let all = collect(dir.path(), &Images::Build(client.clone())).unwrap();
        let html = all["docs"][0].html.clone().unwrap();
        assert!(
            html.contains("<picture><source type=\"image/avif\" srcset=\"/_nowaki/a b-640."),
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
        let err = collect(dir.path(), &Images::Build(client))
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
        let all = collect(dir.path(), &Images::Build(dir.path().join("dist/client"))).unwrap();
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
        let all = collect(r, &Images::Dev).unwrap();
        let blog: Vec<_> = all["blog"].iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(blog, ["2026/a", "b"]);
        assert_eq!(all["blog"][0].file, "content/blog/2026/a.md");
        assert_eq!(all["blog"][0].headings.as_ref().unwrap()[0].id, "a");
        assert_eq!(all["authors"][0].data["name"], "Tettu");
        assert!(all["authors"][0].html.is_none());

        std::fs::write(r.join("content/blog/b.json"), "{}").unwrap();
        let err = collect(r, &Images::Dev).unwrap_err().to_string();
        assert!(err.contains("two entries have the slug \"b\""), "{err}");
    }

    #[test]
    fn a_bad_frontmatter_names_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/blog")).unwrap();
        std::fs::write(r.join("content/blog/x.md"), "---\ntitle: [oops\n---\n").unwrap();
        let err = collect(r, &Images::Dev).unwrap_err().to_string();
        assert!(err.contains("content/blog/x.md: frontmatter"), "{err}");
    }
}
