//! Image asset optimization (pure Rust, no C codecs, so it cross-compiles).
//!
//! The client build passes every imported PNG through [`optimize`] with the default
//! [`Transform`]: it is re-encoded losslessly and kept only if smaller (metadata is dropped
//! too). Other formats are copied as they are.
//!
//! A non-default [`Transform`] (from [`parse_query`]) resizes, converts, and sets the quality,
//! but no import query reaches it: responsive images use `?image` (`image.rs`), which
//! encodes its fallback variants through `encode_as`.
//!
//! WebP is encoded lossless (image-webp). SVG, ICO, video, etc. are untouched.

use anyhow::Result;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageEncoder, ImageFormat};

/// A raster format this module decodes and encodes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Fmt {
    Png,
    Jpeg,
    Webp,
}

impl Fmt {
    fn from_ext(ext: &str) -> Option<Fmt> {
        match ext.to_ascii_lowercase().as_str() {
            "png" => Some(Fmt::Png),
            "jpg" | "jpeg" => Some(Fmt::Jpeg),
            "webp" => Some(Fmt::Webp),
            _ => None,
        }
    }
    fn ext(self) -> &'static str {
        match self {
            Fmt::Png => "png",
            Fmt::Jpeg => "jpg",
            Fmt::Webp => "webp",
        }
    }
    fn image_format(self) -> ImageFormat {
        match self {
            Fmt::Png => ImageFormat::Png,
            Fmt::Jpeg => ImageFormat::Jpeg,
            Fmt::Webp => ImageFormat::WebP,
        }
    }
}

/// What [`optimize`] does beyond the automatic PNG re-encode. The default is nothing.
#[derive(Default, Clone)]
pub struct Transform {
    /// Target width in pixels.
    pub width: Option<u32>,
    /// Target height in pixels. With only one of width and height, the image fits within it and
    /// keeps its aspect ratio; with both, it is resized to exactly that size.
    pub height: Option<u32>,
    /// Output format (default: the input's).
    pub format: Option<Fmt>,
    /// JPEG quality, 1 to 100 (default 80). WebP is always lossless.
    pub quality: Option<u8>,
}

impl Transform {
    /// Whether no resize, format, or quality is set (automatic optimization only).
    fn is_noop(&self) -> bool {
        self.width.is_none()
            && self.height.is_none()
            && self.format.is_none()
            && self.quality.is_none()
    }
}

/// Parses a query string (`w=800&format=webp&quality=80`; also `width`, `h` / `height`, `q`,
/// `f`) into a [`Transform`]. Unknown keys and invalid values are ignored.
pub fn parse_query(q: &str) -> Transform {
    let mut t = Transform::default();
    for pair in q.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "w" | "width" => t.width = v.parse().ok(),
            "h" | "height" => t.height = v.parse().ok(),
            "q" | "quality" => t.quality = v.parse::<u8>().ok().map(|n| n.clamp(1, 100)),
            "format" | "f" => {
                t.format = match v.to_ascii_lowercase().as_str() {
                    "webp" => Some(Fmt::Webp),
                    "jpeg" | "jpg" => Some(Fmt::Jpeg),
                    "png" => Some(Fmt::Png),
                    _ => None,
                }
            }
            _ => {}
        }
    }
    t
}

/// Optimizes image bytes. Returns (optimized bytes, output extension). Unsupported input, a
/// failure, or (in automatic mode) a larger result returns the original bytes and extension.
pub fn optimize(bytes: &[u8], ext: &str, t: &Transform) -> (Vec<u8>, String) {
    match try_optimize(bytes, ext, t) {
        Ok(Some(out)) => out,
        _ => (bytes.to_vec(), ext.to_string()),
    }
}

fn try_optimize(bytes: &[u8], ext: &str, t: &Transform) -> Result<Option<(Vec<u8>, String)>> {
    let Some(in_fmt) = Fmt::from_ext(ext) else {
        return Ok(None); // no image processing for svg/ico/gif/video etc.
    };
    // Automatic (no query) is lossless PNG re-encoding only. Auto-recompressing JPEG/WebP can
    // degrade quality, so it only happens with an explicit query (resize, format, quality).
    if t.is_noop() && in_fmt != Fmt::Png {
        return Ok(None);
    }
    let out_fmt = t.format.unwrap_or(in_fmt);

    // Upright pixels: the EXIF orientation is applied here, since re-encoding drops it.
    let mut img = crate::image::decode_oriented(bytes, Some(in_fmt.image_format()))?;
    if t.width.is_some() || t.height.is_some() {
        img = resize(&img, t.width, t.height);
    }
    let out = encode(&img, out_fmt, t.quality)?;

    if t.is_noop() && out.len() >= bytes.len() {
        return Ok(None);
    }
    Ok(Some((out, out_fmt.ext().to_string())))
}

/// Encodes a decoded image in the format of `ext` (png / jpg / jpeg / webp), for `image.rs`'s
/// fallback variants. None for formats this module doesn't write.
pub(crate) fn encode_as(
    img: &DynamicImage,
    ext: &str,
    quality: Option<u8>,
) -> Result<Option<(Vec<u8>, &'static str)>> {
    let Some(fmt) = Fmt::from_ext(ext) else {
        return Ok(None);
    };
    Ok(Some((encode(img, fmt, quality)?, fmt.ext())))
}

/// One dimension: fit within it, keeping the aspect ratio. Both: exact resize.
fn resize(img: &DynamicImage, w: Option<u32>, h: Option<u32>) -> DynamicImage {
    match (w, h) {
        (Some(w), Some(h)) => img.resize_exact(w, h, FilterType::Lanczos3),
        (Some(w), None) => img.resize(w, u32::MAX, FilterType::Lanczos3),
        (None, Some(h)) => img.resize(u32::MAX, h, FilterType::Lanczos3),
        (None, None) => img.clone(),
    }
}

fn encode(img: &DynamicImage, fmt: Fmt, quality: Option<u8>) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    match fmt {
        Fmt::Png => {
            let enc =
                PngEncoder::new_with_quality(&mut out, CompressionType::Best, PngFilter::Adaptive);
            let rgba = img.to_rgba8();
            enc.write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )?;
        }
        Fmt::Jpeg => {
            let q = quality.unwrap_or(80);
            let mut enc = JpegEncoder::new_with_quality(&mut out, q);
            let rgb = img.to_rgb8();
            enc.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )?;
        }
        Fmt::Webp => {
            let enc = WebPEncoder::new_lossless(&mut out);
            let rgba = img.to_rgba8();
            enc.write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use std::io::Cursor;

    fn sample_png() -> Vec<u8> {
        let img = ImageBuffer::from_fn(64, 48, |x, y| {
            Rgba([(x * 4) as u8, (y * 5) as u8, 128, 255])
        });
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn parses_query() {
        let t = parse_query("w=800&format=webp&quality=80");
        assert_eq!(t.width, Some(800));
        assert_eq!(t.quality, Some(80));
        assert!(matches!(t.format, Some(Fmt::Webp)));
    }

    #[test]
    fn resize_changes_dimensions() {
        let png = sample_png();
        let t = Transform {
            width: Some(32),
            ..Default::default()
        };
        let (out, ext) = optimize(&png, "png", &t);
        assert_eq!(ext, "png");
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!(decoded.width(), 32); // 64 → 32 (aspect ratio kept)
    }

    #[test]
    fn converts_to_webp_and_jpeg() {
        let png = sample_png();
        let (webp, ext) = optimize(
            &png,
            "png",
            &Transform {
                format: Some(Fmt::Webp),
                ..Default::default()
            },
        );
        assert_eq!(ext, "webp");
        assert_eq!(image::guess_format(&webp).unwrap(), ImageFormat::WebP);

        let (jpg, ext) = optimize(
            &png,
            "png",
            &Transform {
                format: Some(Fmt::Jpeg),
                quality: Some(70),
                ..Default::default()
            },
        );
        assert_eq!(ext, "jpg");
        assert_eq!(image::guess_format(&jpg).unwrap(), ImageFormat::Jpeg);
    }

    #[test]
    fn non_image_passes_through() {
        let (out, ext) = optimize(b"<svg/>", "svg", &Transform::default());
        assert_eq!(out, b"<svg/>");
        assert_eq!(ext, "svg");
    }

    #[test]
    fn auto_png_recompresses_smaller() {
        // A weakly compressed PNG (CompressionType::Fast) shrinks under automatic optimization
        // (Best).
        let img = ImageBuffer::from_fn(96, 96, |x, y| {
            Rgba([(x * 2) as u8, (y * 2) as u8, ((x + y) * 3) as u8, 255])
        });
        let mut weak = Vec::new();
        let enc =
            PngEncoder::new_with_quality(&mut weak, CompressionType::Fast, PngFilter::NoFilter);
        enc.write_image(
            DynamicImage::ImageRgba8(img).to_rgba8().as_raw(),
            96,
            96,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();

        let (out, ext) = optimize(&weak, "png", &Transform::default());
        assert_eq!(ext, "png");
        assert!(
            out.len() < weak.len(),
            "auto PNG opt should shrink: {} -> {}",
            weak.len(),
            out.len()
        );
    }
}
