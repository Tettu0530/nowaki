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
//!   own metrics, so text doesn't shift when the font arrives. The metrics come from a local
//!   `.ttf` / `.otf` or from Google's TrueType file; a family with only woff / woff2 files gets
//!   no fallback face.
//! - `--font-<family>` (or `variable`) holds the stack: `"Inter", "Inter Fallback", sans-serif`.
//! - Pages get the stylesheet and `<link rel="preload">` for the latin, upright faces of the
//!   families with `preload` (the default). Google's CJK families come as ~120 numbered
//!   `unicode-range` slices with no subset name. Those aren't preloaded (unless one covers basic
//!   Latin and `subsets` includes latin); the browser fetches the slices a page uses.
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
    /// `subsets` includes latin (local families: always).
    latin: bool,
}

/// `nowaki build` / `prerender`: writes the faces and the stylesheet into `dist/client` and
/// `dist/server/fonts.json`, or removes a stale `fonts.json` when the config has no fonts.
pub fn build_dist(root: &Path, dist: &Path, config: &Value) -> Result<()> {
    let json_out = dist.join("server/fonts.json");
    let _ = std::fs::remove_file(&json_out);
    let base = crate::site::asset_base();
    let Some(out) = build(root, config, &dist.join("client"), base)? else {
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

/// `{ css, preload: [{ href, type }], variables: { name: stack } }`, or `None` without `fonts`.
fn build(root: &Path, config: &Value, out_dir: &Path, prefix: &str) -> Result<Option<Value>> {
    let Some(specs) = config.get("fonts").and_then(Value::as_array) else {
        return Ok(None);
    };
    if specs.is_empty() {
        return Ok(None);
    }
    let families = resolve(root, specs)?;
    emit(&families, out_dir, prefix).map(Some)
}

/// Writes the faces and the stylesheet for `families`; returns the `fonts.json` value.
fn emit(families: &[Family], out_dir: &Path, prefix: &str) -> Result<Value> {
    std::fs::create_dir_all(out_dir)?;
    let mut css = String::new();
    let mut preload = Vec::new();
    let mut variables = serde_json::Map::new();
    for fam in families {
        let fam_slug = slug(&fam.family);
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
            // A variable font's range (`"100 900"`) is a valid CSS weight but not a file name.
            let name = format!(
                "{fam_slug}-{}-{}{subset}.{:08x}.{ext}",
                slug(&face.weight),
                slug(&face.style),
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
                "@font-face {{\n  font-family: {};\n  font-style: {};\n  font-weight: {};\n  font-display: {};\n  src: url(\"{url}\") format(\"{format}\");\n",
                css_string(&fam.family),
                face.style,
                face.weight,
                fam.display
            ));
            if let Some(r) = &face.unicode_range {
                css.push_str(&format!("  unicode-range: {r};\n"));
            }
            css.push_str("}\n");
            if fam.preload && preloadable(face, fam.latin) && face.style == "normal" {
                preload.push(json!({ "href": url, "type": format!("font/{}", if format == "opentype" { "otf" } else if format == "truetype" { "ttf" } else { format }) }));
            }
        }
        let (generic, local, fb_upm, fb_avg) = FALLBACKS
            .iter()
            .find(|f| f.0 == fam.fallback)
            .copied()
            .unwrap_or(FALLBACKS[0]);
        let fallback_name = format!("{} Fallback", fam.family);
        // A fallback face needs the font's metrics; woff / woff2 aren't read (metrics come from
        // a .ttf / .otf, or Google's TrueType), so such a family's stack goes straight to generic.
        let mut has_fallback = false;
        if let Some(m) = fam.metrics.as_deref().and_then(|p| metrics(p).ok()) {
            has_fallback = true;
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
        let stack = if has_fallback {
            format!(
                "{}, {}, {generic}",
                css_string(&fam.family),
                css_string(&fallback_name)
            )
        } else {
            format!("{}, {generic}", css_string(&fam.family))
        };
        variables.insert(fam.variable.clone(), Value::String(stack));
    }
    css.push_str(":root {\n");
    for (k, v) in &variables {
        css.push_str(&format!("  {k}: {};\n", v.as_str().unwrap_or("")));
    }
    css.push_str("}\n");
    let css_name = format!("fonts.{:08x}.css", xxh3_64(css.as_bytes()) as u32);
    std::fs::write(out_dir.join(&css_name), &css)?;
    Ok(json!({ "css": format!("{prefix}{css_name}"), "preload": preload, "variables": variables }))
}

/// Whether a face is a latin one worth a preload: a `latin` subset, a whole local file, or (for
/// Google's unnamed CJK slices) the slice whose `unicode-range` covers basic Latin.
fn preloadable(face: &Face, latin: bool) -> bool {
    match (face.subset.as_deref(), face.unicode_range.as_deref()) {
        (Some(s), _) => s == "latin",
        (None, None) => true,
        (None, Some(range)) => latin && range_covers(range, 'A' as u32),
    }
}

/// Whether a CSS `unicode-range` (`U+0-FF, U+131, U+4??`) includes `cp`.
fn range_covers(range: &str, cp: u32) -> bool {
    range.split(',').any(|part| {
        let part = part.trim();
        let Some(spec) = part.strip_prefix("U+").or_else(|| part.strip_prefix("u+")) else {
            return false;
        };
        let hex = |s: &str| u32::from_str_radix(s, 16).ok();
        let (lo, hi) = if let Some((a, b)) = spec.split_once('-') {
            (hex(a), hex(b))
        } else if spec.contains('?') {
            (hex(&spec.replace('?', "0")), hex(&spec.replace('?', "F")))
        } else {
            (hex(spec), hex(spec))
        };
        matches!((lo, hi), (Some(lo), Some(hi)) if lo <= cp && cp <= hi)
    })
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
            latin: spec
                .get("subsets")
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty())
                .is_none_or(|a| a.iter().any(|s| s.as_str() == Some("latin"))),
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
    parse_metrics(&data).ok_or_else(|| {
        anyhow!(
            "{}: not a TrueType / OpenType font with head, hhea and OS/2 average width",
            path.display()
        )
    })
}

/// Reads [`Metrics`] from a TrueType / OpenType font (the first face of a collection). Only the
/// `head`, `hhea` and `OS/2` tables are read; the rules match what ttf-parser (used before 0.18.2)
/// returned for a face at its default variation coordinates.
fn parse_metrics(data: &[u8]) -> Option<Metrics> {
    let u16_at = |b: &[u8], at: usize| b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]]));
    let i16_at = |b: &[u8], at: usize| u16_at(b, at).map(|v| v as i16);
    let u32_at = |b: &[u8], at: usize| {
        b.get(at..at + 4)
            .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    };
    // A collection (`ttcf`): the first font's offset table.
    let start = if data.get(0..4)? == b"ttcf" {
        if u32_at(data, 8)? == 0 {
            return None;
        }
        u32_at(data, 12)? as usize
    } else {
        0
    };
    // TrueType (0x00010000 or `true`) or CFF (`OTTO`).
    if !matches!(
        data.get(start..start + 4)?,
        [0, 1, 0, 0] | b"true" | b"OTTO"
    ) {
        return None;
    }
    let num_tables = u16_at(data, start + 4)? as usize;
    let table = |tag: &[u8; 4]| -> Option<&[u8]> {
        (0..num_tables).find_map(|i| {
            let rec = start + 12 + i * 16;
            if data.get(rec..rec + 4)? != tag {
                return None;
            }
            let offset = u32_at(data, rec + 8)? as usize;
            let len = u32_at(data, rec + 12)? as usize;
            data.get(offset..offset.checked_add(len)?)
        })
    };
    // Table lengths are checked against their minimum only: some fonts pad them.
    let head = table(b"head").filter(|t| t.len() >= 54)?;
    let upm = u16_at(head, 18)?;
    if !(16..=16384).contains(&upm) {
        return None;
    }
    let hhea = table(b"hhea").filter(|t| t.len() >= 36)?;
    let (h_asc, h_desc, h_gap) = (i16_at(hhea, 4)?, i16_at(hhea, 6)?, i16_at(hhea, 8)?);
    let os2_raw = table(b"OS/2");
    // The parsed OS/2 fields need a known version and that version's full length.
    let os2 = os2_raw.filter(|t| {
        let min = match u16_at(t, 0) {
            Some(0) => 78,
            Some(1) => 86,
            Some(2..=4) => 96,
            Some(5) => 100,
            _ => return false,
        };
        t.len() >= min
    });
    let (ascent, descent, line_gap) = match os2 {
        // fsSelection bit 7, USE_TYPO_METRICS (OS/2 version 4 and later).
        Some(t) if u16_at(t, 0)? >= 4 && u16_at(t, 62)? & (1 << 7) != 0 => {
            (i16_at(t, 68)?, i16_at(t, 70)?, i16_at(t, 72)?)
        }
        _ => {
            let (typo_asc, typo_desc, typo_gap) = match os2 {
                Some(t) => (i16_at(t, 68)?, i16_at(t, 70)?, i16_at(t, 72)?),
                None => (0, 0, 0),
            };
            let (win_asc, win_desc) = match os2 {
                Some(t) => (i16_at(t, 74)?, i16_at(t, 76)?.wrapping_neg()),
                None => (0, 0),
            };
            // A zero hhea value falls back to the typographic one, then to the Windows one.
            let pick = |h: i16, typo: i16, win: i16| match (h, os2.is_some()) {
                (0, true) if typo != 0 => typo,
                (0, true) => win,
                _ => h,
            };
            let gap = if (h_asc == 0 || h_desc == 0) && os2.is_some() {
                if typo_asc != 0 || typo_desc != 0 {
                    typo_gap
                } else {
                    0
                }
            } else {
                h_gap
            };
            (
                pick(h_asc, typo_asc, win_asc),
                pick(h_desc, typo_desc, win_desc),
                gap,
            )
        }
    };
    // xAvgCharWidth is the second field of OS/2, read whatever the table's version.
    let avg = os2_raw
        .and_then(|t| i16_at(t, 2))
        .map(f64::from)
        .filter(|a| *a > 0.0)?;
    Some(Metrics {
        upm: f64::from(upm),
        ascent: f64::from(ascent),
        descent: f64::from(descent),
        line_gap: f64::from(line_gap),
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
    fn a_weight_range_gets_a_safe_file_name_and_no_fallback_without_metrics() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("fonts")).unwrap();
        // Any bytes do: woff2 isn't parsed (that's the point: no metrics, so no fallback face).
        std::fs::write(dir.path().join("fonts/v.woff2"), b"wOF2 not really").unwrap();
        let config = json!({ "fonts": [{ "family": "Geist Variable", "src": "./fonts/v.woff2", "weight": "100 900" }] });
        let out_dir = dir.path().join("out");
        let out = build(dir.path(), &config, &out_dir, "/_nowaki/")
            .unwrap()
            .unwrap();
        let css = std::fs::read_to_string(
            out_dir.join(out["css"].as_str().unwrap().trim_start_matches("/_nowaki/")),
        )
        .unwrap();
        assert!(css.contains("font-weight: 100 900;"), "{css}");
        assert!(
            css.contains("src: url(\"/_nowaki/geist-variable-100-900-normal."),
            "{css}"
        );
        assert!(!css.contains("Fallback"), "{css}");
        assert!(
            css.contains("--font-geist-variable: \"Geist Variable\", sans-serif;"),
            "{css}"
        );
        assert!(!out["preload"][0]["href"].as_str().unwrap().contains(' '));
    }

    #[test]
    fn metrics_are_sane() {
        let m = metrics(&example_font()).unwrap();
        assert!(m.upm >= 1000.0 && m.ascent > 0.0 && m.descent < 0.0 && m.avg > 0.0);
        // The values ttf-parser read from this file (USE_TYPO_METRICS is set).
        let got = (m.upm, m.ascent, m.descent, m.line_gap, m.avg);
        assert_eq!(got, (1000.0, 950.0, -290.0, 0.0, 534.0));
    }

    /// OS/2 fields: version, xAvgCharWidth, fsSelection, typo (asc, desc, gap), win (asc, desc).
    type Os2 = (u16, i16, u16, (i16, i16, i16), (u16, u16));

    /// A minimal sfnt with `head`, `hhea` and (optionally) `OS/2`, wrapped in a collection when
    /// `ttc`.
    struct Font {
        upm: u16,
        hhea: (i16, i16, i16),
        os2: Option<Os2>,
        ttc: bool,
    }

    impl Font {
        fn bytes(&self) -> Vec<u8> {
            let mut head = vec![0u8; 54];
            head[18..20].copy_from_slice(&self.upm.to_be_bytes());
            let mut hhea = vec![0u8; 36];
            hhea[4..6].copy_from_slice(&self.hhea.0.to_be_bytes());
            hhea[6..8].copy_from_slice(&self.hhea.1.to_be_bytes());
            hhea[8..10].copy_from_slice(&self.hhea.2.to_be_bytes());
            let mut tables: Vec<(&[u8; 4], Vec<u8>)> = vec![(b"head", head), (b"hhea", hhea)];
            if let Some((version, avg, fs, typo, win)) = self.os2 {
                let mut os2 = vec![0u8; 100];
                os2[0..2].copy_from_slice(&version.to_be_bytes());
                os2[2..4].copy_from_slice(&avg.to_be_bytes());
                os2[62..64].copy_from_slice(&fs.to_be_bytes());
                os2[68..70].copy_from_slice(&typo.0.to_be_bytes());
                os2[70..72].copy_from_slice(&typo.1.to_be_bytes());
                os2[72..74].copy_from_slice(&typo.2.to_be_bytes());
                os2[74..76].copy_from_slice(&win.0.to_be_bytes());
                os2[76..78].copy_from_slice(&win.1.to_be_bytes());
                tables.push((b"OS/2", os2));
            }
            let start: usize = if self.ttc { 16 } else { 0 };
            let mut out = Vec::new();
            if self.ttc {
                out.extend_from_slice(b"ttcf");
                out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
                out.extend_from_slice(&1u32.to_be_bytes());
                out.extend_from_slice(&(start as u32).to_be_bytes());
            }
            out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
            out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
            out.extend_from_slice(&[0; 6]);
            let mut offset = start + 12 + tables.len() * 16;
            for (tag, data) in &tables {
                out.extend_from_slice(*tag);
                out.extend_from_slice(&[0; 4]);
                out.extend_from_slice(&(offset as u32).to_be_bytes());
                out.extend_from_slice(&(data.len() as u32).to_be_bytes());
                offset += data.len();
            }
            for (_, data) in &tables {
                out.extend_from_slice(data);
            }
            out
        }
    }

    fn read(font: &Font) -> Option<(f64, f64, f64, f64, f64)> {
        parse_metrics(&font.bytes()).map(|m| (m.upm, m.ascent, m.descent, m.line_gap, m.avg))
    }

    #[test]
    fn metrics_follow_use_typo_metrics_and_the_hhea_fallbacks() {
        let font = |hhea, os2| Font {
            upm: 2048,
            hhea,
            os2,
            ttc: false,
        };
        // USE_TYPO_METRICS (bit 7) on OS/2 v4: the typographic values win over hhea.
        let typo = font(
            (900, -300, 10),
            Some((4, 1100, 0x80, (800, -200, 50), (1000, 400))),
        );
        assert_eq!(read(&typo), Some((2048.0, 800.0, -200.0, 50.0, 1100.0)));
        // The bit means nothing before OS/2 v4: hhea.
        let v3 = font(
            (900, -300, 10),
            Some((3, 1100, 0x80, (800, -200, 50), (1000, 400))),
        );
        assert_eq!(read(&v3), Some((2048.0, 900.0, -300.0, 10.0, 1100.0)));
        // A zero hhea ascent / descent falls back to typographic, and the gap follows.
        let zero = font((0, 0, 10), Some((4, 1100, 0, (800, -200, 50), (1000, 400))));
        assert_eq!(read(&zero), Some((2048.0, 800.0, -200.0, 50.0, 1100.0)));
        // ...then to the Windows values (descent negated), with no gap.
        let win = font((0, 0, 10), Some((4, 1100, 0, (0, 0, 50), (1000, 400))));
        assert_eq!(read(&win), Some((2048.0, 1000.0, -400.0, 0.0, 1100.0)));
        // The first face of a collection.
        let ttc = Font {
            upm: 1000,
            hhea: (900, -300, 10),
            os2: Some((4, 500, 0, (0, 0, 0), (0, 0))),
            ttc: true,
        };
        assert_eq!(read(&ttc), Some((1000.0, 900.0, -300.0, 10.0, 500.0)));
    }

    #[test]
    fn metrics_reject_what_has_no_fallback_values() {
        let ok = || Font {
            upm: 1000,
            hhea: (900, -300, 0),
            os2: Some((4, 500, 0, (0, 0, 0), (0, 0))),
            ttc: false,
        };
        assert!(read(&ok()).is_some());
        // No OS/2 (no average width), a zero average width, an out-of-range unitsPerEm.
        assert_eq!(read(&Font { os2: None, ..ok() }), None);
        assert_eq!(
            read(&Font {
                os2: Some((4, 0, 0, (0, 0, 0), (0, 0))),
                ..ok()
            }),
            None
        );
        assert_eq!(read(&Font { upm: 8, ..ok() }), None);
        // Not an sfnt, truncated data, a woff2.
        let bytes = ok().bytes();
        assert!(parse_metrics(&bytes[..bytes.len() / 2]).is_none());
        assert!(parse_metrics(b"wOF2 not really").is_none());
        assert!(parse_metrics(b"").is_none());
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

    /// Google's CSS for a CJK family (Noto Sans JP, as served in 2026-11): ~120 numbered slices
    /// with a `unicode-range` and no subset comment, then `/* latin */` and friends.
    fn cjk_family(dir: &Path, slices: &[(Option<&str>, &str)], subsets_latin: bool) -> Family {
        let faces = slices
            .iter()
            .enumerate()
            .map(|(i, (subset, range))| {
                let file = dir.join(format!("{i}.woff2"));
                std::fs::write(&file, format!("slice {i}")).unwrap();
                Face {
                    weight: "400".into(),
                    style: "normal".into(),
                    subset: subset.map(str::to_string),
                    unicode_range: Some(range.to_string()),
                    file,
                }
            })
            .collect();
        Family {
            family: "Noto Sans JP".into(),
            faces,
            metrics: None,
            fallback: "sans-serif".into(),
            variable: "--font-noto".into(),
            display: "swap".into(),
            preload: true,
            latin: subsets_latin,
        }
    }

    #[test]
    fn cjk_slices_preload_only_the_latin_one() {
        let dir = tempfile::tempdir().unwrap();
        let out_dir = dir.path().join("out");
        let cjk = [
            (None, "U+25ee8, U+25f23, U+4e00-4e3f"),
            (None, "U+3000-303f, U+3041-3096"),
            (None, "U+ff??"),
        ];
        let mut with_latin = cjk.to_vec();
        with_latin.push((Some("latin"), "U+0000-00FF, U+0131, U+0152-0153"));
        let fam = cjk_family(dir.path(), &with_latin, true);
        let out = emit(&[fam], &out_dir, "/_nowaki/").unwrap();
        let pre = out["preload"].as_array().unwrap();
        assert_eq!(pre.len(), 1, "{pre:?}");
        assert!(pre[0]["href"].as_str().unwrap().contains("-normal-latin."));
        // Every slice keeps its @font-face, so the browser still fetches what a page uses.
        let css = std::fs::read_to_string(
            out_dir.join(out["css"].as_str().unwrap().trim_start_matches("/_nowaki/")),
        )
        .unwrap();
        assert_eq!(css.matches("unicode-range:").count(), 4, "{css}");
        // Unnamed slices only: the one that covers basic Latin.
        let mut unnamed = cjk.to_vec();
        unnamed.push((None, "U+0-ff, U+131"));
        let out = emit(
            &[cjk_family(dir.path(), &unnamed, true)],
            &out_dir,
            "/_nowaki/",
        )
        .unwrap();
        assert_eq!(out["preload"].as_array().unwrap().len(), 1);
        // `subsets` without latin (fonts-fetch drops the labelled latin face): nothing.
        let out = emit(
            &[cjk_family(dir.path(), &unnamed, false)],
            &out_dir,
            "/_nowaki/",
        )
        .unwrap();
        assert_eq!(out["preload"].as_array().unwrap().len(), 0);
        let out = emit(&[cjk_family(dir.path(), &cjk, true)], &out_dir, "/_nowaki/").unwrap();
        assert_eq!(out["preload"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn unicode_ranges() {
        assert!(range_covers("U+0-FF", 0x41));
        assert!(range_covers("U+0000-00FF, U+0131", 0x131));
        assert!(range_covers("U+00??", 0x41));
        assert!(!range_covers("U+4??", 0x41));
        assert!(!range_covers("U+3000-303F", 0x41));
        assert!(!range_covers("garbage", 0x41));
    }
}
