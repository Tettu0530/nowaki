//! Pre-compression of client output (gzip and brotli siblings, written at build time) and the
//! shared encoders `nowaki start` uses for ISR pages.

use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::Result;
use rayon::prelude::*;

/// Files smaller than this aren't worth a compressed sibling (headers cost more than they save).
pub const MIN_SIZE: usize = 1024;

/// Whether a file name has a text type that compresses well. Source maps are left out: only
/// devtools fetch them, and brotli at quality 11 on large maps would slow every build down.
pub fn is_compressible(name: &str) -> bool {
    matches!(
        name.rsplit('.').next().unwrap_or(""),
        "js" | "mjs" | "css" | "json" | "svg" | "html" | "xml" | "txt" | "wasm"
    )
}

/// gzip with no file name and mtime 0, so the output is reproducible.
pub fn gzip(data: &[u8], level: u32) -> Vec<u8> {
    let mut enc = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::new(level));
    enc.write_all(data).expect("in-memory write");
    enc.finish().expect("in-memory write")
}

/// Brotli at `quality` (0 to 11) with a 4 MiB window.
pub fn brotli(data: &[u8], quality: u32) -> Vec<u8> {
    let mut out = Vec::new();
    let params = brotli::enc::BrotliEncoderParams {
        quality: quality as i32,
        lgwin: 22,
        size_hint: data.len(),
        ..Default::default()
    };
    brotli::BrotliCompress(&mut &data[..], &mut out, &params).expect("in-memory write");
    out
}

/// Writes `<file>.gz` and `<file>.br` next to every compressible file in `dir` (not recursive),
/// at the highest levels, only when they come out smaller than the original. Returns how many
/// siblings it wrote.
pub fn precompress_dir(dir: &Path) -> Result<usize> {
    let files: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_compressible)
        })
        .collect();
    let written = files
        .par_iter()
        .map(|path| -> Result<usize> {
            let data = fs::read(path)?;
            if data.len() < MIN_SIZE {
                return Ok(0);
            }
            let mut n = 0;
            for (ext, bytes) in [("gz", gzip(&data, 9)), ("br", brotli(&data, 11))] {
                if bytes.len() < data.len() {
                    let mut name = path.as_os_str().to_owned();
                    name.push(".");
                    name.push(ext);
                    fs::write(name, bytes)?;
                    n += 1;
                }
            }
            Ok(n)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(written.into_iter().sum())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn gzip_round_trips_and_is_reproducible() {
        let data = "export const x = 1;\n".repeat(200);
        let a = gzip(data.as_bytes(), 9);
        assert_eq!(a, gzip(data.as_bytes(), 9));
        let mut out = String::new();
        flate2::read::GzDecoder::new(&a[..])
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(out, data);
    }

    #[test]
    fn brotli_round_trips() {
        let data = "body { color: red }\n".repeat(200);
        let c = brotli(data.as_bytes(), 11);
        let mut out = Vec::new();
        brotli::BrotliDecompress(&mut &c[..], &mut out).unwrap();
        assert_eq!(out, data.as_bytes());
    }

    #[test]
    fn precompress_writes_siblings_for_large_text_files_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("big.js"), "let a = 1;\n".repeat(500)).unwrap();
        fs::write(dir.path().join("small.js"), "let a = 1;").unwrap();
        fs::write(dir.path().join("big.js.map"), "{}".repeat(2000)).unwrap();
        fs::write(dir.path().join("photo.png"), vec![0u8; 5000]).unwrap();
        assert_eq!(precompress_dir(dir.path()).unwrap(), 2);
        assert!(dir.path().join("big.js.gz").is_file());
        assert!(dir.path().join("big.js.br").is_file());
        assert!(!dir.path().join("small.js.gz").exists());
        assert!(!dir.path().join("big.js.map.gz").exists());
        assert!(!dir.path().join("photo.png.gz").exists());
    }
}
