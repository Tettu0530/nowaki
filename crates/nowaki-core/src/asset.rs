//! Image asset optimization (pure Rust, no C codecs, so it cross-compiles).
//!
//! The client build passes every imported asset through [`optimize`]: a PNG is re-encoded
//! losslessly and kept only if smaller (metadata is dropped too); other formats are copied as
//! they are. Responsive images use `?image` (`image.rs`), which encodes its fallback variants
//! through `encode_as`.
//!
//! WebP is encoded lossless (image-webp). SVG, ICO, video, etc. are untouched.

use anyhow::Result;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageEncoder, ImageFormat};

/// A raster format this module decodes and encodes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fmt {
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
}

/// Optimizes an imported asset. Returns (bytes, output extension): a PNG re-encoded losslessly
/// when that is smaller, anything else (or a failure) the original untouched.
pub fn optimize(bytes: &[u8], ext: &str) -> (Vec<u8>, String) {
    match try_optimize(bytes, ext) {
        Ok(Some(out)) => out,
        _ => (bytes.to_vec(), ext.to_string()),
    }
}

fn try_optimize(bytes: &[u8], ext: &str) -> Result<Option<(Vec<u8>, String)>> {
    // Lossless PNG re-encoding only: recompressing JPEG / WebP could degrade them.
    if Fmt::from_ext(ext) != Some(Fmt::Png) {
        return Ok(None);
    }
    // Upright pixels: the EXIF orientation is applied here, since re-encoding drops it.
    let img = crate::image::decode_oriented(bytes, Some(ImageFormat::Png))?;
    let out = encode(&img, Fmt::Png, None)?;
    if out.len() >= bytes.len() {
        return Ok(None);
    }
    Ok(Some((out, Fmt::Png.ext().to_string())))
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
    fn encodes_webp_and_jpeg() {
        let img = image::load_from_memory(&sample_png()).unwrap();
        let (webp, ext) = encode_as(&img, "webp", None).unwrap().unwrap();
        assert_eq!(ext, "webp");
        assert_eq!(image::guess_format(&webp).unwrap(), ImageFormat::WebP);
        let (jpg, ext) = encode_as(&img, "jpeg", Some(70)).unwrap().unwrap();
        assert_eq!(ext, "jpg");
        assert_eq!(image::guess_format(&jpg).unwrap(), ImageFormat::Jpeg);
        assert!(encode_as(&img, "gif", None).unwrap().is_none());
    }

    #[test]
    fn jpeg_is_not_recompressed() {
        let img = image::load_from_memory(&sample_png()).unwrap();
        let (jpg, _) = encode_as(&img, "jpg", Some(100)).unwrap().unwrap();
        let (out, ext) = optimize(&jpg, "jpg");
        assert_eq!(out, jpg);
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn non_image_passes_through() {
        let (out, ext) = optimize(b"<svg/>", "svg");
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

        let (out, ext) = optimize(&weak, "png");
        assert_eq!(ext, "png");
        assert!(
            out.len() < weak.len(),
            "auto PNG opt should shrink: {} -> {}",
            weak.len(),
            out.len()
        );
    }
}
