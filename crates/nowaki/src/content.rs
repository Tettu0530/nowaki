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
use comrak::{format_html, parse_document, Arena, Options};
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
pub fn collect(root: &Path) -> Result<BTreeMap<String, Vec<Entry>>> {
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
        for path in files {
            if let Some(e) = read_entry(root, &coll, &path)? {
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
    Ok(out)
}

/// Writes `<out_dir>/index.json`. Returns the number of entries.
pub fn write(root: &Path, out_dir: &Path) -> Result<usize> {
    let all = collect(root)?;
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
    let n = write(root, &dist.join("server/content"))?;
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
            let (html, headings) = render_markdown(body);
            Entry {
                slug,
                file,
                data,
                body: Some(body.to_string()),
                html: Some(html),
                headings: Some(headings),
            }
        }
        "json" => Entry {
            data: serde_json::from_str(&text()?).map_err(|e| anyhow!("{file}: {e}"))?,
            slug,
            file,
            body: None,
            html: None,
            headings: None,
        },
        "yaml" | "yml" => Entry {
            data: yaml_to_json(&text()?).map_err(|e| anyhow!("{file}: {e}"))?,
            slug,
            file,
            body: None,
            html: None,
            headings: None,
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

/// Renders Markdown to HTML and lists its headings (with the same ids as the anchors comrak adds).
pub fn render_markdown(md: &str) -> (String, Vec<Heading>) {
    let arena = Arena::new();
    let options = markdown_options();
    let doc = parse_document(&arena, md, &options);
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
    let mut html = String::new();
    format_html(doc, &options, &mut html).expect("writing to a String");
    (html, headings)
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
        let all = collect(r).unwrap();
        let blog: Vec<_> = all["blog"].iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(blog, ["2026/a", "b"]);
        assert_eq!(all["blog"][0].file, "content/blog/2026/a.md");
        assert_eq!(all["blog"][0].headings.as_ref().unwrap()[0].id, "a");
        assert_eq!(all["authors"][0].data["name"], "Tettu");
        assert!(all["authors"][0].html.is_none());

        std::fs::write(r.join("content/blog/b.json"), "{}").unwrap();
        let err = collect(r).unwrap_err().to_string();
        assert!(err.contains("two entries have the slug \"b\""), "{err}");
    }

    #[test]
    fn a_bad_frontmatter_names_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::create_dir_all(r.join("content/blog")).unwrap();
        std::fs::write(r.join("content/blog/x.md"), "---\ntitle: [oops\n---\n").unwrap();
        let err = collect(r).unwrap_err().to_string();
        assert!(err.contains("content/blog/x.md: frontmatter"), "{err}");
    }
}
