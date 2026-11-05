//! Font optimization: `fonts` in nowaki.config, self-hosted at build time.
//!
//! ```js
//! fonts: [
//!   { family: "Inter", provider: "google", weights: [400, 700], subsets: ["latin"] },
//!   { family: "Brand", src: "./fonts/brand.ttf", weight: 400, fallback: "serif" },
//! ]
//! ```
//!
//! - Google fonts are downloaded by `server/fonts-fetch.mjs` (one woff2 per subset, with its
//!   `unicode-range`, so a page only loads the subsets it uses) and cached; pages never request
//!   a third-party host. Local fonts are copied as they are.
//! - Every face gets a content-hashed file under `/_nowaki/` and an `@font-face`
//!   (`font-display: swap` by default).
//! - A fallback face per family (`"<Family> Fallback"`, a local Arial / Times New Roman / Courier
//!   New) gets `size-adjust` and ascent / descent / line-gap overrides computed from the font's
//!   own metrics, so text doesn't shift when the font arrives.
//! - `--font-<family>` (or `variable`) holds the stack: `"Inter", "Inter Fallback", sans-serif`.
//! - Pages get the stylesheet and `<link rel="preload">` for the latin, upright faces of the
//!   families with `preload` (the default).
//!
//! `nowaki build` writes `dist/client/fonts.<hash>.css`, the faces, and `dist/server/fonts.json`
//! (the runtime reads it); `nowaki dev` writes the same under `.nowaki/fonts/`.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use xxhash_rust::xxh3::xxh3_64;

/// The fallback faces' metrics: units per em, xAvgCharWidth (OS/2). Arial / Times New Roman /
/// Courier New are on every desktop OS, which is why they are the fallbacks.
const FALLBACKS: [(&str, &str, f64, f64); 3] = [
    ("sans-serif", "Arial", 2048.0, 904.0),
    ("serif", "Times New Roman", 2048.0, 821.0),
    ("monospace", "Courier New", 2048.0, 1229.0),
];

struct Face {
    weight: String,
    style: String,
    subset: Option<String>,
    unicode_range: Option<String>,
    file: PathBuf,
}

struct Family {
    family: String,
    faces: Vec<Face>,
    /// A TrueType / OpenType file to read metrics from.
    metrics: Option<PathBuf>,
    fallback: String,
    variable: String,
    display: String,
    preload: bool,
}

/// `nowaki build` / `prerender`: faces and stylesheet into `dist/client`, `dist/server/fonts.json`.
pub fn build_dist(root: &Path, dist: &Path, config: &Value) -> Result<()> {
    let json_out = dist.join("server/fonts.json");
    let _ = std::fs::remove_file(&json_out);
    let Some(out) = build(root, config, &dist.join("client"), "/_nowaki/")? else {
        return Ok(());
    };
    std::fs::create_dir_all(dist.join("server"))?;
    std::fs::write(json_out, out.to_string())?;
    Ok(())
}

/// `nowaki dev`: the same under `.nowaki/fonts/` (served at `/__nowaki/fonts/`), and
/// `.nowaki/fonts.json`. Errors are reported, not fatal: the pages just use the fallbacks.
pub fn build_dev(root: &Path, config: &Value) {
    let dir = root.join(".nowaki/fonts");
    let json_out = root.join(".nowaki/fonts.json");
    let _ = std::fs::remove_file(&json_out);
    match build(root, config, &dir, "/__nowaki/fonts/") {
        Ok(Some(out)) => {
            let _ = std::fs::write(json_out, out.to_string());
        }
        Ok(None) => {}
        Err(e) => eprintln!("[nowaki] fonts: {e:#}"),
    }
}

/// `{ css, preload: [href], variables: { name: stack } }`, or None without `fonts`.
fn build(root: &Path, config: &Value, out_dir: &Path, prefix: &str) -> Result<Option<Value>> {
    let Some(specs) = config.get("fonts").and_then(Value::as_array) else {
        return Ok(None);
    };
    if specs.is_empty() {
        return Ok(None);
    }
    let families = resolve(root, specs)?;
    std::fs::create_dir_all(out_dir)?;
    let mut css = String::new();
    let mut preload = Vec::new();
    let mut variables = serde_json::Map::new();
    for fam in &families {
        let slug = slug(&fam.family);
        for face in &fam.faces {
            let bytes = std::fs::read(&face.file).with_context(|| {
                format!("{}: failed to read {}", fam.family, face.file.display())
            })?;
            let ext = face
                .file
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("woff2")
                .to_ascii_lowercase();
            let subset = face
                .subset
                .as_deref()
                .map(|s| format!("-{s}"))
                .unwrap_or_default();
            let name = format!(
                "{slug}-{}-{}{subset}.{:08x}.{ext}",
                face.weight,
                face.style,
                xxh3_64(&bytes) as u32
            );
            let path = out_dir.join(&name);
            if !path.exists() {
                std::fs::write(&path, &bytes)?;
            }
            let url = format!("{prefix}{name}");
            let format = match ext.as_str() {
                "woff2" => "woff2",
                "woff" => "woff",
                "otf" => "opentype",
                _ => "truetype",
            };
            css.push_str(&format!(
                "@font-face {{\n  font-family: {};\n  font-style: {};\n  font-weight: {};\n  font-display: {};\n  src: url({url}) format(\"{format}\");\n",
                css_string(&fam.family),
                face.style,
                face.weight,
                fam.display
            ));
            if let Some(r) = &face.unicode_range {
                css.push_str(&format!("  unicode-range: {r};\n"));
            }
            css.push_str("}\n");
            let latin = face.subset.as_deref().is_none_or(|s| s == "latin");
            if fam.preload && latin && face.style == "normal" {
                preload.push(json!({ "href": url, "type": format!("font/{}", if format == "opentype" { "otf" } else if format == "truetype" { "ttf" } else { format }) }));
            }
        }
        let (generic, local, fb_upm, fb_avg) = FALLBACKS
            .iter()
            .find(|f| f.0 == fam.fallback)
            .copied()
            .unwrap_or(FALLBACKS[0]);
        let fallback_name = format!("{} Fallback", fam.family);
        if let Some(m) = fam.metrics.as_deref().and_then(|p| metrics(p).ok()) {
            let size_adjust = (m.avg / m.upm) / (fb_avg / fb_upm);
            let pct = |v: f64| format!("{:.2}%", v * 100.0);
            css.push_str(&format!(
                "@font-face {{\n  font-family: {};\n  src: local({});\n  size-adjust: {};\n  ascent-override: {};\n  descent-override: {};\n  line-gap-override: {};\n}}\n",
                css_string(&fallback_name),
                css_string(local),
                pct(size_adjust),
                pct(m.ascent / (m.upm * size_adjust)),
                pct(m.descent.abs() / (m.upm * size_adjust)),
                pct(m.line_gap / (m.upm * size_adjust)),
            ));
        }
        let stack = format!(
            "{}, {}, {generic}",
            css_string(&fam.family),
            css_string(&fallback_name)
        );
        variables.insert(fam.variable.clone(), Value::String(stack));
    }
    css.push_str(":root {\n");
    for (k, v) in &variables {
        css.push_str(&format!("  {k}: {};\n", v.as_str().unwrap_or("")));
    }
    css.push_str("}\n");
    let css_name = format!("fonts.{:08x}.css", xxh3_64(css.as_bytes()) as u32);
    std::fs::write(out_dir.join(&css_name), &css)?;
    Ok(Some(
        json!({ "css": format!("{prefix}{css_name}"), "preload": preload, "variables": variables }),
    ))
}

fn resolve(root: &Path, specs: &[Value]) -> Result<Vec<Family>> {
    let mut google = Vec::new();
    let mut out: Vec<(usize, Family)> = Vec::new();
    for (i, spec) in specs.iter().enumerate() {
        let family = spec
            .get("family")
            .and_then(Value::as_str)
            .filter(|f| !f.trim().is_empty())
            .ok_or_else(|| anyhow!("fonts[{i}]: `family` is required"))?
            .to_string();
        let str_of = |k: &str| spec.get(k).and_then(Value::as_str).map(str::to_string);
        let fallback = str_of("fallback").unwrap_or_else(|| "sans-serif".into());
        if !FALLBACKS.iter().any(|f| f.0 == fallback) {
            bail!("{family}: `fallback` must be \"sans-serif\", \"serif\", or \"monospace\"");
        }
        let base = Family {
            variable: str_of("variable").unwrap_or_else(|| format!("--font-{}", slug(&family))),
            display: str_of("display").unwrap_or_else(|| "swap".into()),
            preload: spec.get("preload").and_then(Value::as_bool).unwrap_or(true),
            family: family.clone(),
            faces: Vec::new(),
            metrics: None,
            fallback,
        };
        if str_of("provider").as_deref() == Some("google") {
            google.push((i, spec.clone()));
            out.push((i, base));
            continue;
        }
        let entries: Vec<Value> = match spec.get("src") {
            Some(Value::String(s)) => vec![json!({ "path": s, "weight": spec.get("weight"), "style": spec.get("style") })],
            Some(Value::Array(a)) => a.clone(),
            _ => bail!("{family}: give `src` (a file or [{{ path, weight, style }}]) or `provider: \"google\"`"),
        };
        let mut fam = base;
        for e in entries {
            let p = e
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("{family}: each `src` entry needs a `path`"))?;
            let file = root.join(p.trim_start_matches("./"));
            if !file.is_file() {
                bail!("{family}: {p} not found (paths are relative to the app root)");
            }
            let ext = file
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if fam.metrics.is_none() && (ext == "ttf" || ext == "otf") {
                fam.metrics = Some(file.clone());
            }
            fam.faces.push(Face {
                weight: value_str(e.get("weight")).unwrap_or_else(|| "400".into()),
                style: e
                    .get("style")
                    .and_then(Value::as_str)
                    .unwrap_or("normal")
                    .to_string(),
                subset: None,
                unicode_range: None,
                file,
            });
        }
        out.push((i, fam));
    }
    if !google.is_empty() {
        for (i, faces, metrics) in fetch_google(root, &google)? {
            if let Some((_, fam)) = out.iter_mut().find(|(j, _)| *j == i) {
                fam.faces = faces;
                fam.metrics = metrics;
            }
        }
    }
    Ok(out.into_iter().map(|(_, f)| f).collect())
}

type GoogleFaces = Vec<(usize, Vec<Face>, Option<PathBuf>)>;

fn fetch_google(root: &Path, specs: &[(usize, Value)]) -> Result<GoogleFaces> {
    use std::io::Write;
    let script = root.join("node_modules/@nowaki-dev/runtime/server/fonts-fetch.mjs");
    if !script.exists() {
        bail!("Google fonts need @nowaki-dev/runtime 0.16 or newer (server/fonts-fetch.mjs not found)");
    }
    let cache = root.join("node_modules/.cache/nowaki/fonts");
    let mut child = std::process::Command::new("node")
        .arg(&script)
        .arg(&cache)
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("failed to run node for Google fonts")?;
    let input = Value::Array(specs.iter().map(|(_, s)| s.clone()).collect()).to_string();
    child
        .stdin
        .take()
        .expect("piped")
        .write_all(input.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "Google fonts: {}",
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .lines()
                .last()
                .unwrap_or("download failed")
        );
    }
    let list: Vec<Value> =
        serde_json::from_slice(&output.stdout).context("fonts-fetch.mjs printed invalid JSON")?;
    let mut out = Vec::new();
    for ((i, _), fam) in specs.iter().zip(list) {
        let faces = fam["faces"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| Face {
                weight: value_str(f.get("weight")).unwrap_or_else(|| "400".into()),
                style: f["style"].as_str().unwrap_or("normal").to_string(),
                subset: f["subset"].as_str().map(str::to_string),
                unicode_range: f["unicodeRange"].as_str().map(str::to_string),
                file: PathBuf::from(f["file"].as_str().unwrap_or_default()),
            })
            .collect();
        out.push((*i, faces, fam["metrics"].as_str().map(PathBuf::from)));
    }
    Ok(out)
}

struct Metrics {
    upm: f64,
    ascent: f64,
    descent: f64,
    line_gap: f64,
    avg: f64,
}

/// Units per em, the ascent / descent / line gap browsers use (typographic when the font says so,
/// else hhea), and OS/2 xAvgCharWidth.
fn metrics(path: &Path) -> Result<Metrics> {
    let data = std::fs::read(path)?;
    let face = ttf_parser::Face::parse(&data, 0).map_err(|e| anyhow!("{}: {e}", path.display()))?;
    let os2 = face.tables().os2;
    let (ascent, descent, line_gap) = match os2 {
        Some(t) if t.use_typographic_metrics() => (
            t.typographic_ascender() as f64,
            t.typographic_descender() as f64,
            t.typographic_line_gap() as f64,
        ),
        _ => (
            face.ascender() as f64,
            face.descender() as f64,
            face.line_gap() as f64,
        ),
    };
    // xAvgCharWidth is the second field of OS/2 (ttf-parser doesn't expose it).
    let avg = face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"OS/2"))
        .filter(|t| t.len() >= 4)
        .map(|t| i16::from_be_bytes([t[2], t[3]]) as f64)
        .filter(|a| *a > 0.0)
        .ok_or_else(|| anyhow!("{}: no OS/2 average width", path.display()))?;
    Ok(Metrics {
        upm: face.units_per_em() as f64,
        ascent,
        descent,
        line_gap,
        avg,
    })
}

fn value_str(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// A CSS string: `"Inter"`, with `"` and `\` escaped.
fn css_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example_font() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/hello/fonts/atkinson-hyperlegible-400.ttf")
    }

    #[test]
    fn local_font_gets_a_face_a_sized_fallback_and_a_variable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("fonts")).unwrap();
        std::fs::copy(example_font(), dir.path().join("fonts/a.ttf")).unwrap();
        let config = json!({ "fonts": [{ "family": "Atkinson Hyperlegible", "src": "./fonts/a.ttf", "variable": "--font-body" }] });
        let out_dir = dir.path().join("out");
        let out = build(dir.path(), &config, &out_dir, "/_nowaki/")
            .unwrap()
            .unwrap();
        let css_href = out["css"].as_str().unwrap();
        let css = std::fs::read_to_string(out_dir.join(css_href.trim_start_matches("/_nowaki/")))
            .unwrap();
        assert!(
            css.contains("font-family: \"Atkinson Hyperlegible\";"),
            "{css}"
        );
        assert!(css.contains("font-display: swap;"), "{css}");
        assert!(css.contains("format(\"truetype\")"), "{css}");
        assert!(css.contains("font-family: \"Atkinson Hyperlegible Fallback\";\n  src: local(\"Arial\");\n  size-adjust: "), "{css}");
        assert!(css.contains("ascent-override: "), "{css}");
        assert!(css.contains("--font-body: \"Atkinson Hyperlegible\", \"Atkinson Hyperlegible Fallback\", sans-serif;"), "{css}");
        let pre = out["preload"].as_array().unwrap();
        assert_eq!(pre.len(), 1);
        assert_eq!(pre[0]["type"], "font/ttf");
        assert!(out_dir
            .join(
                pre[0]["href"]
                    .as_str()
                    .unwrap()
                    .trim_start_matches("/_nowaki/")
            )
            .is_file());
    }

    #[test]
    fn metrics_are_sane() {
        let m = metrics(&example_font()).unwrap();
        assert!(m.upm >= 1000.0 && m.ascent > 0.0 && m.descent < 0.0 && m.avg > 0.0);
    }

    #[test]
    fn rejects_bad_specs() {
        let dir = tempfile::tempdir().unwrap();
        for spec in [
            json!({}),
            json!({ "family": "X" }),
            json!({ "family": "X", "src": "./nope.ttf" }),
            json!({ "family": "X", "src": "./a", "fallback": "cursive" }),
        ] {
            assert!(build(
                dir.path(),
                &json!({ "fonts": [spec] }),
                &dir.path().join("o"),
                "/"
            )
            .is_err());
        }
        assert!(build(dir.path(), &json!({}), &dir.path().join("o"), "/")
            .unwrap()
            .is_none());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Atkinson Hyperlegible"), "atkinson-hyperlegible");
        assert_eq!(slug(" Noto  Sans JP!"), "noto-sans-jp");
    }
}
