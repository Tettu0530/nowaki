//! Responsive images: `import hero from "./hero.jpg?image"` gives an object for `<Image>`
//! (`@nowaki-dev/runtime/image`) instead of a URL string:
//!
//! ```text
//! { src, width, height, sources: [{ type: "image/avif", srcset }, { type: "image/jpeg", srcset }] }
//! ```
//!
//! - `width` / `height` come from the file, so the browser reserves the space (no layout shift).
//!   The EXIF orientation is applied to the size and to the pixels, so a portrait phone photo
//!   stored landscape comes out upright.
//! - Widths: 640, 960, 1280, 1920 below the original, plus the original (at most 2560), or the
//!   list in `?image&w=400,800`. Nothing is upscaled.
//! - Formats: AVIF (lossy, pure Rust through ravif / rav1e without asm), then the original
//!   format (JPEG / PNG / WebP) as the fallback. `?image&q=` sets the AVIF quality (default 60).
//! - SVG, GIF, and other formats pass through as a single source with no resizing.
//!
//! Encoding AVIF is slow, so every variant is cached under `node_modules/.cache/nowaki/images`,
//! keyed by the file's bytes and the parameters; a second build or a dev reload reuses it.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder};
use rayon::prelude::*;
use xxhash_rust::xxh3::xxh3_64;

const DEFAULT_WIDTHS: [u32; 4] = [640, 960, 1280, 1920];
const MAX_WIDTH: u32 = 2560;
const DEFAULT_AVIF_QUALITY: u8 = 60;
/// rav1e speed (1 slowest … 10 fastest). 9 was ~30% faster than 7 on photos at the same or a
/// smaller size; 10 grew the files by ~60%.
const AVIF_SPEED: u8 = 9;
/// Alpha is encoded near-losslessly: at the colour quality, fully transparent or opaque edges
/// came back off by up to 38 levels. Opaque images carry no alpha plane, so this costs them nothing.
const AVIF_ALPHA_QUALITY: f32 = 100.0;

/// `?image` and its options.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImageQuery {
    pub widths: Option<Vec<u32>>,
    pub quality: Option<u8>,
}

/// Splits `…/hero.jpg?image&w=400` into the file and the query (without `?`). oxc_resolver's
/// `full_path()` keeps the query on the path.
pub fn split_query(p: &Path) -> (PathBuf, Option<String>) {
    let s = p.to_string_lossy();
    match s.split_once('?') {
        Some((file, q)) => (PathBuf::from(file), Some(q.to_string())),
        None => (p.to_path_buf(), None),
    }
}

/// The options when `q` asks for an image set (`image` is one of its keys), else None.
pub fn image_query(q: &str) -> Option<ImageQuery> {
    let mut found = false;
    let mut out = ImageQuery::default();
    for pair in q.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "image" => found = true,
            "w" | "widths" => {
                let ws: Vec<u32> = v
                    .split(',')
                    .filter_map(|w| w.trim().parse().ok())
                    .filter(|w| *w > 0)
                    .collect();
                if !ws.is_empty() {
                    out.widths = Some(ws);
                }
            }
            "q" | "quality" => out.quality = v.parse::<u8>().ok().map(|n| n.clamp(1, 100)),
            _ => {}
        }
    }
    found.then_some(out)
}

/// Whether `abs` (no query) is an image `?image` resizes and converts.
pub fn is_raster(abs: &Path) -> bool {
    matches!(ext_of(abs).as_str(), "png" | "jpg" | "jpeg" | "webp")
}

fn ext_of(abs: &Path) -> String {
    abs.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// The widths to produce for an image `orig` pixels wide.
pub fn widths_for(orig: u32, q: &ImageQuery) -> Vec<u32> {
    let cap = orig.min(MAX_WIDTH);
    let mut out: Vec<u32> = match &q.widths {
        Some(ws) => ws.iter().map(|w| (*w).min(orig)).collect(),
        None => DEFAULT_WIDTHS
            .iter()
            .copied()
            .filter(|w| *w < cap)
            .chain([cap])
            .collect(),
    };
    out.sort_unstable();
    out.dedup();
    out
}

/// One `<source>` (or the `<img>`'s own srcset): a type and `(url, width)` candidates.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub mime: &'static str,
    pub candidates: Vec<(String, u32)>,
}

/// What `?image` imports: the module's default export (see `module`).
#[derive(Debug, Clone, PartialEq)]
pub struct ImageSet {
    /// Intrinsic size; 0 when the format isn't decoded (SVG).
    pub width: u32,
    pub height: u32,
    /// The `<img src>`: the largest fallback.
    pub src: String,
    /// AVIF first, the fallback format last (the `<img>` uses the last one).
    pub sources: Vec<Source>,
}

impl ImageSet {
    /// `export default { … }` as an ES module.
    pub fn module(&self) -> String {
        let js = |s: &str| format!("{s:?}");
        let sources: Vec<String> = self
            .sources
            .iter()
            .map(|s| {
                let srcset: Vec<String> = s
                    .candidates
                    .iter()
                    .map(|(u, w)| format!("{u} {w}w"))
                    .collect();
                format!(
                    "{{ type: {}, srcset: {} }}",
                    js(s.mime),
                    js(&srcset.join(", "))
                )
            })
            .collect();
        format!(
            "export default {{ src: {}, width: {}, height: {}, sources: [{}] }};\n",
            js(&self.src),
            self.width,
            self.height,
            sources.join(", ")
        )
    }
}

/// A produced file: (width, extension, bytes).
type Variant = (u32, &'static str, Vec<u8>);

/// Builds the variants for `abs` (cached on disk) and names them through `name_of(stem, width,
/// ext, bytes)`, which writes the file and returns its URL. Raster images get AVIF + the original
/// format per width; anything else is passed through once.
pub fn build_set(
    root: &Path,
    abs: &Path,
    q: &ImageQuery,
    mut name_of: impl FnMut(&str, u32, &str, &[u8]) -> Result<String>,
) -> Result<ImageSet> {
    let raw = std::fs::read(abs).with_context(|| format!("failed to read {}", abs.display()))?;
    let ext = ext_of(abs);
    let stem = abs
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    if !is_raster(abs) {
        let (w, h) = image::load_from_memory(&raw)
            .map(|i| (i.width(), i.height()))
            .unwrap_or((0, 0));
        let url = name_of(&stem, w, &ext, &raw)?;
        return Ok(ImageSet {
            width: w,
            height: h,
            src: url.clone(),
            sources: vec![Source {
                mime: mime_of(&ext),
                candidates: vec![(url, w)],
            }],
        });
    }
    // The size from the header; the pixels are decoded only if a variant isn't cached yet (a
    // rebuild with every variant cached decodes nothing).
    let (width, height) = oriented_size(&raw)
        .with_context(|| format!("failed to read the size of {}", abs.display()))?;
    let decoded: std::sync::OnceLock<std::result::Result<DynamicImage, String>> =
        std::sync::OnceLock::new();
    let img = || -> Result<&DynamicImage> {
        decoded
            .get_or_init(|| decode_oriented(&raw, None).map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| anyhow::anyhow!("failed to decode {}: {e}", abs.display()))
    };
    let widths = widths_for(width, q);
    let quality = q.quality.unwrap_or(DEFAULT_AVIF_QUALITY);
    let cache = cache_dir(root);
    let source_hash = xxh3_64(&raw);

    let jobs: Vec<(u32, bool)> = widths
        .iter()
        .flat_map(|w| [(*w, true), (*w, false)])
        .collect();
    let variants: Vec<Result<Variant>> = jobs
        .par_iter()
        .map(|(w, avif)| {
            variant(
                &img,
                width,
                &ext,
                *w,
                *avif,
                quality,
                source_hash,
                cache.as_deref(),
                true,
            )
        })
        .collect();
    let mut avif = Vec::new();
    let mut fallback = Vec::new();
    let mut fallback_ext = "";
    for v in variants {
        let (w, out_ext, bytes) = v?;
        let url = name_of(&stem, w, out_ext, &bytes)?;
        if out_ext == "avif" {
            avif.push((url, w));
        } else {
            fallback_ext = out_ext;
            fallback.push((url, w));
        }
    }
    avif.sort_by_key(|(_, w)| *w);
    fallback.sort_by_key(|(_, w)| *w);
    let src = fallback.last().map(|(u, _)| u.clone()).unwrap_or_default();
    Ok(ImageSet {
        width,
        height,
        src,
        sources: vec![
            Source {
                mime: "image/avif",
                candidates: avif,
            },
            Source {
                mime: mime_of(fallback_ext),
                candidates: fallback,
            },
        ],
    })
}

/// Writes one variant into `out_dir` (dist/client) as `{stem}-{width}.{hash}.{ext}` and returns
/// its URL. The name hashes the bytes, so the client build, the server build, and Markdown entries
/// that use the same image write the same files.
pub fn write_variant(
    out_dir: &Path,
    stem: &str,
    width: u32,
    ext: &str,
    bytes: &[u8],
) -> Result<String> {
    // Every caller gets a name `nowaki start` serves (Markdown content images included).
    let stem = crate::build::sanitize_name(stem);
    let name = format!("{stem}-{width}.{:08x}.{ext}", xxh3_64(bytes) as u32);
    std::fs::create_dir_all(out_dir)?;
    let path = out_dir.join(&name);
    if !path.exists() {
        std::fs::write(&path, bytes)?;
    }
    Ok(format!("/_nowaki/{name}"))
}

/// The `<picture>` HTML `<Image>` renders for `set` (Markdown images use this; keep the two in
/// step). `alt` and `title` are plain text.
pub fn picture_html(set: &ImageSet, alt: &str, title: Option<&str>) -> String {
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let sizes = (set.width > 0).then(|| format!("(min-width: {w}px) {w}px, 100vw", w = set.width));
    let srcset = |s: &Source| {
        s.candidates
            .iter()
            .map(|(u, w)| format!("{u} {w}w"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let sizes_attr = sizes
        .as_deref()
        .map(|s| format!(" sizes=\"{s}\""))
        .unwrap_or_default();
    let sources: Vec<&Source> = set
        .sources
        .iter()
        .filter(|s| !s.candidates.is_empty())
        .collect();
    let mut img = format!("<img src=\"{}\"", esc(&set.src));
    if let Some(last) = sources.last() {
        img.push_str(&format!(" srcset=\"{}\"{sizes_attr}", esc(&srcset(last))));
    }
    if set.width > 0 && set.height > 0 {
        img.push_str(&format!(
            " width=\"{}\" height=\"{}\"",
            set.width, set.height
        ));
    }
    img.push_str(&format!(" alt=\"{}\"", esc(alt)));
    if let Some(t) = title.filter(|t| !t.is_empty()) {
        img.push_str(&format!(" title=\"{}\"", esc(t)));
    }
    img.push_str(" loading=\"lazy\" decoding=\"async\" />");
    if sources.len() < 2 {
        return img;
    }
    let mut out = String::from("<picture>");
    for s in &sources[..sources.len() - 1] {
        out.push_str(&format!(
            "<source type=\"{}\" srcset=\"{}\"{sizes_attr} />",
            s.mime,
            esc(&srcset(s))
        ));
    }
    out.push_str(&img);
    out.push_str("</picture>");
    out
}

/// The bytes of one variant, for the dev server (`/__nowaki/image`).
pub fn dev_variant(
    root: &Path,
    abs: &Path,
    width: u32,
    avif: bool,
    quality: Option<u8>,
) -> Result<(Vec<u8>, &'static str)> {
    let raw = std::fs::read(abs)?;
    let ext = ext_of(abs);
    if !is_raster(abs) {
        return Ok((raw, mime_of(&ext)));
    }
    let (orig_w, _) = oriented_size(&raw)?;
    let w = width.clamp(1, orig_w);
    let decoded: std::sync::OnceLock<std::result::Result<DynamicImage, String>> =
        std::sync::OnceLock::new();
    let img = || -> Result<&DynamicImage> {
        decoded
            .get_or_init(|| decode_oriented(&raw, None).map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| anyhow::anyhow!("{e}"))
    };
    let (_, out_ext, bytes) = variant(
        &img,
        orig_w,
        &ext,
        w,
        avif,
        quality.unwrap_or(DEFAULT_AVIF_QUALITY),
        xxh3_64(&raw),
        cache_dir(root).as_deref(),
        false, // one image per request in dev: let the encoder use the cores
    )?;
    Ok((bytes, mime_of(out_ext)))
}

/// The set for the dev server: sizes from the file header, URLs to `/__nowaki/image` (encoded on
/// first request, then cached).
pub fn dev_set(root: &Path, abs: &Path, q: &ImageQuery) -> Result<ImageSet> {
    let file = crate::resolve::fs_path_to_url(root, abs);
    let enc = query_encode(&file);
    let ext = ext_of(abs);
    let quality = q.quality.map(|n| format!("&q={n}")).unwrap_or_default();
    if !is_raster(abs) {
        let (w, h) = image::image_dimensions(abs).unwrap_or((0, 0));
        return Ok(ImageSet {
            width: w,
            height: h,
            src: file.clone(),
            sources: vec![Source {
                mime: mime_of(&ext),
                candidates: vec![(file, w)],
            }],
        });
    }
    let (width, height) = std::fs::read(abs)
        .map_err(anyhow::Error::from)
        .and_then(|raw| oriented_size(&raw))
        .with_context(|| format!("failed to read {}", abs.display()))?;
    let widths = widths_for(width, q);
    let url = |w: u32, f: &str| format!("/__nowaki/image?f={enc}&w={w}&fmt={f}{quality}");
    let avif = widths.iter().map(|w| (url(*w, "avif"), *w)).collect();
    let fallback: Vec<(String, u32)> = widths.iter().map(|w| (url(*w, "orig"), *w)).collect();
    let src = fallback.last().map(|(u, _)| u.clone()).unwrap_or_default();
    let fallback_mime = mime_of(if ext == "jpeg" { "jpg" } else { &ext });
    Ok(ImageSet {
        width,
        height,
        src,
        sources: vec![
            Source {
                mime: "image/avif",
                candidates: avif,
            },
            Source {
                mime: fallback_mime,
                candidates: fallback,
            },
        ],
    })
}

/// The displayed size from the header alone (no pixel decode): the stored size, swapped when the
/// EXIF orientation turns the image by 90° or 270°.
fn oriented_size(raw: &[u8]) -> Result<(u32, u32)> {
    let mut dec = image::ImageReader::new(std::io::Cursor::new(raw))
        .with_guessed_format()?
        .into_decoder()?;
    let (w, h) = dec.dimensions();
    let o = dec.orientation().unwrap_or(Orientation::NoTransforms);
    Ok(if swaps_axes(o) { (h, w) } else { (w, h) })
}

fn swaps_axes(o: Orientation) -> bool {
    matches!(
        o,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

/// Decodes `raw` and applies its EXIF orientation, so the pixels are upright (re-encoding drops
/// the EXIF data the browser would otherwise have used). `format` None guesses from the bytes.
pub(crate) fn decode_oriented(
    raw: &[u8],
    format: Option<image::ImageFormat>,
) -> image::ImageResult<DynamicImage> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(raw));
    match format {
        Some(f) => reader.set_format(f),
        None => reader = reader.with_guessed_format()?,
    }
    let mut dec = reader.into_decoder()?;
    let o = dec.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(dec)?;
    img.apply_orientation(o);
    Ok(img)
}

fn cache_dir(root: &Path) -> Option<PathBuf> {
    let dir = root.join("node_modules/.cache/nowaki/images");
    std::fs::create_dir_all(&dir).ok().map(|_| dir)
}

/// `img` decodes on first call (shared by the variants of one image); `orig_width` is the file's
/// width, known from its header.
#[allow(clippy::too_many_arguments)]
fn variant<'a>(
    img: &(dyn Fn() -> Result<&'a DynamicImage> + Sync),
    orig_width: u32,
    ext: &str,
    width: u32,
    avif: bool,
    quality: u8,
    source_hash: u64,
    cache: Option<&Path>,
    // One encoder thread per image when the variants of a build already run in parallel: rav1e's
    // own threading only adds tiles, which cost bytes (1-28% at the same quality) for no speed.
    single_thread: bool,
) -> Result<Variant> {
    let out_ext: &'static str = if avif {
        "avif"
    } else {
        match ext {
            "png" => "png",
            "webp" => "webp",
            _ => "jpg",
        }
    };
    let key = xxh3_64(
        format!(
            "{}|{source_hash:x}|{width}|{out_ext}|{quality}|{AVIF_SPEED}|a{AVIF_ALPHA_QUALITY}|t{}|oriented",
            env!("CARGO_PKG_VERSION"),
            if avif && single_thread { "1" } else { "n" }
        )
        .as_bytes(),
    );
    let cached = cache.map(|d| d.join(format!("{key:016x}.{out_ext}")));
    if let Some(bytes) = cached.as_ref().and_then(|p| std::fs::read(p).ok()) {
        return Ok((width, out_ext, bytes));
    }
    let img = img()?;
    let scaled = if width < orig_width {
        img.resize(width, u32::MAX, FilterType::Lanczos3)
    } else {
        img.clone()
    };
    let bytes = if avif {
        encode_avif(&scaled, quality, single_thread)?
    } else {
        // JPEG fallback at a fixed quality; PNG / WebP stay lossless.
        let q = (out_ext == "jpg").then_some(82);
        crate::asset::encode_as(&scaled, out_ext, q)?
            .map(|(b, _)| b)
            .context("unsupported fallback format")?
    };
    if let Some(p) = cached {
        let _ = std::fs::write(p, &bytes); // a cache miss next time is the only cost
    }
    Ok((width, out_ext, bytes))
}

fn encode_avif(img: &DynamicImage, quality: u8, single_thread: bool) -> Result<Vec<u8>> {
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let pixels: Vec<ravif::RGBA8> = rgba
        .as_raw()
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| ravif::RGBA8::new(c[0], c[1], c[2], c[3]))
        .collect();
    let out = ravif::Encoder::new()
        .with_quality(quality as f32)
        .with_alpha_quality(AVIF_ALPHA_QUALITY)
        .with_speed(AVIF_SPEED)
        .with_num_threads(single_thread.then_some(1))
        .encode_rgba(ravif::Img::new(pixels.as_slice(), w, h))
        .map_err(|e| anyhow::anyhow!("AVIF encode failed: {e}"))?;
    Ok(out.avif_file)
}

fn query_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/@".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_query() {
        assert_eq!(image_query("image"), Some(ImageQuery::default()));
        assert_eq!(
            image_query("image&w=400,800&q=70"),
            Some(ImageQuery {
                widths: Some(vec![400, 800]),
                quality: Some(70)
            })
        );
        assert_eq!(image_query("w=400"), None);
        let (f, q) = split_query(Path::new("/a/hero.jpg?image&w=1"));
        assert_eq!(
            (f, q.as_deref()),
            (PathBuf::from("/a/hero.jpg"), Some("image&w=1"))
        );
    }

    #[test]
    fn plans_widths_without_upscaling() {
        assert_eq!(
            widths_for(3000, &ImageQuery::default()),
            [640, 960, 1280, 1920, 2560]
        );
        assert_eq!(widths_for(1000, &ImageQuery::default()), [640, 960, 1000]);
        assert_eq!(widths_for(300, &ImageQuery::default()), [300]);
        let q = ImageQuery {
            widths: Some(vec![800, 400, 2000]),
            quality: None,
        };
        assert_eq!(widths_for(1000, &q), [400, 800, 1000]);
    }

    #[test]
    fn builds_avif_and_fallback_variants() {
        let dir = tempfile::tempdir().unwrap();
        let img = image::RgbImage::from_fn(1000, 500, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let file = dir.path().join("hero.jpg");
        img.save(&file).unwrap();
        let mut written = Vec::new();
        let set = build_set(
            dir.path(),
            &file,
            &ImageQuery::default(),
            |stem, w, ext, bytes| {
                written.push((format!("{stem}-{w}.{ext}"), bytes.len()));
                Ok(format!("/_nowaki/{stem}-{w}.{ext}"))
            },
        )
        .unwrap();
        assert_eq!((set.width, set.height), (1000, 500));
        assert_eq!(set.src, "/_nowaki/hero-1000.jpg");
        assert_eq!(set.sources[0].mime, "image/avif");
        assert_eq!(
            set.sources[0]
                .candidates
                .iter()
                .map(|c| c.1)
                .collect::<Vec<_>>(),
            [640, 960, 1000]
        );
        assert_eq!(set.sources[1].mime, "image/jpeg");
        assert_eq!(written.len(), 6);
        assert!(set.module().contains("image/avif"));
        assert!(set.module().contains("/_nowaki/hero-640.avif 640w"));
        // The second build reads every variant from the cache.
        let again = build_set(
            dir.path(),
            &file,
            &ImageQuery::default(),
            |stem, w, ext, _| Ok(format!("/_nowaki/{stem}-{w}.{ext}")),
        )
        .unwrap();
        assert_eq!(again, set);
        assert!(
            std::fs::read_dir(dir.path().join("node_modules/.cache/nowaki/images"))
                .unwrap()
                .count()
                >= 6
        );
    }

    /// A 40x20 JPEG (left half red, right half blue) tagged EXIF Orientation=6: displayed upright
    /// it's 20x40 with red on top, as a phone stores a portrait photo.
    fn rotated_jpeg(path: &Path) {
        let img = image::RgbImage::from_fn(40, 20, |x, _| {
            if x < 20 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        });
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        // APP1 Exif: big-endian TIFF, one IFD entry: Orientation (0x0112), SHORT, 1, value 6.
        let exif: &[u8] = b"Exif\0\0MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x06\x00\x00\x00\x00\x00\x00";
        let len = (exif.len() + 2) as u16;
        let mut out = jpeg[..2].to_vec(); // SOI
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(exif);
        out.extend_from_slice(&jpeg[2..]);
        std::fs::write(path, out).unwrap();
    }

    #[test]
    fn applies_the_exif_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("portrait.jpg");
        rotated_jpeg(&file);
        let mut jpg = None;
        let set = build_set(
            dir.path(),
            &file,
            &ImageQuery::default(),
            |stem, w, ext, bytes| {
                if ext == "jpg" {
                    jpg = Some(bytes.to_vec());
                }
                Ok(format!("/_nowaki/{stem}-{w}.{ext}"))
            },
        )
        .unwrap();
        assert_eq!((set.width, set.height), (20, 40));
        let out = image::load_from_memory(&jpg.unwrap()).unwrap().to_rgb8();
        assert_eq!(out.dimensions(), (20, 40));
        let (top, bottom) = (out.get_pixel(10, 5), out.get_pixel(10, 35));
        assert!(top[0] > 200 && top[2] < 60, "top should be red: {top:?}");
        assert!(
            bottom[2] > 200 && bottom[0] < 60,
            "bottom should be blue: {bottom:?}"
        );
        // Dev reads the size from the header the same way.
        let dev = dev_set(dir.path(), &file, &ImageQuery::default()).unwrap();
        assert_eq!((dev.width, dev.height), (20, 40));
        let (bytes, _) = dev_variant(dir.path(), &file, 20, false, None).unwrap();
        let out = image::load_from_memory(&bytes).unwrap();
        assert_eq!((out.width(), out.height()), (20, 40));
    }

    #[test]
    fn variant_names_are_servable() {
        let dir = std::env::temp_dir().join(format!("nowaki-variant-{}", std::process::id()));
        let url = write_variant(&dir, "photo@2x b", 320, "avif", b"x").unwrap();
        assert!(url.contains("photo_2x_b-320."), "{url}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
