//! Content negotiation for `nowaki start`: pre-compressed variants (br / gzip), weak ETags and
//! 304 Not Modified. Used for `/_nowaki/*` assets and ISR pages.

use axum::body::Body;
use axum::body::Bytes;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Brotli,
    Gzip,
    Identity,
}

/// One response body in every encoding we have for it.
#[derive(Debug, Clone)]
pub struct Variants {
    pub plain: Bytes,
    pub gzip: Option<Bytes>,
    pub brotli: Option<Bytes>,
    /// Weak (`W/"…"`): the same tag covers every encoding of the same content.
    pub etag: String,
}

impl Variants {
    pub fn new(plain: Bytes, gzip: Option<Bytes>, brotli: Option<Bytes>) -> Self {
        let etag = etag_of(&plain);
        Variants {
            plain,
            gzip,
            brotli,
            etag,
        }
    }

    /// Compresses `plain` now (ISR pages: once per stored render, not per response). gzip 6 and
    /// brotli 5 keep this to about a millisecond for a typical page.
    pub fn compressed(plain: Bytes) -> Self {
        let keep = |c: Vec<u8>| (c.len() < plain.len()).then(|| Bytes::from(c));
        let (gzip, brotli) = if plain.len() >= nowaki_core::compress::MIN_SIZE {
            (
                keep(nowaki_core::compress::gzip(&plain, 6)),
                keep(nowaki_core::compress::brotli(&plain, 5)),
            )
        } else {
            (None, None)
        };
        Variants::new(plain, gzip, brotli)
    }

    fn has_alternatives(&self) -> bool {
        self.gzip.is_some() || self.brotli.is_some()
    }

    /// Sets ETag / Vary / Content-Encoding on `builder` and returns the matching body, or a 304
    /// when the client already holds this version.
    pub fn respond(
        &self,
        req: &HeaderMap,
        mut builder: axum::http::response::Builder,
        status: u16,
    ) -> Response {
        builder = builder.header(header::ETAG, self.etag.as_str());
        if self.has_alternatives() {
            builder = builder.header(header::VARY, "Accept-Encoding");
        }
        if status == 200 && not_modified(req, &self.etag) {
            return builder
                .status(StatusCode::NOT_MODIFIED)
                .body(Body::empty())
                .expect("valid response");
        }
        let accept = req
            .get(header::ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok());
        let (body, enc) = match pick(accept, self.brotli.is_some(), self.gzip.is_some()) {
            Encoding::Brotli => (self.brotli.clone().unwrap(), Some("br")),
            Encoding::Gzip => (self.gzip.clone().unwrap(), Some("gzip")),
            Encoding::Identity => (self.plain.clone(), None),
        };
        if let Some(e) = enc {
            builder = builder.header(header::CONTENT_ENCODING, HeaderValue::from_static(e));
        }
        builder
            .status(status)
            .body(Body::from(body))
            .expect("valid response")
    }
}

pub fn etag_of(data: &[u8]) -> String {
    format!("W/\"{:016x}\"", xxhash_rust::xxh3::xxh3_64(data))
}

/// Accept-Encoding with q-values: br over gzip over identity; `q=0` refuses an encoding.
pub fn pick(accept: Option<&str>, has_br: bool, has_gzip: bool) -> Encoding {
    let Some(accept) = accept else {
        return Encoding::Identity;
    };
    let q_of = |name: &str| -> f32 {
        let mut star = None;
        for part in accept.split(',') {
            let mut it = part.split(';');
            let token = it.next().unwrap_or("").trim().to_ascii_lowercase();
            let q = it
                .find_map(|p| {
                    p.trim()
                        .strip_prefix("q=")
                        .and_then(|v| v.trim().parse::<f32>().ok())
                })
                .unwrap_or(1.0);
            if token == name {
                return q;
            }
            if token == "*" {
                star = Some(q);
            }
        }
        star.unwrap_or(0.0)
    };
    let br = if has_br { q_of("br") } else { 0.0 };
    let gz = if has_gzip { q_of("gzip") } else { 0.0 };
    if br > 0.0 && br >= gz {
        Encoding::Brotli
    } else if gz > 0.0 {
        Encoding::Gzip
    } else {
        Encoding::Identity
    }
}

/// If-None-Match with weak comparison (RFC 9110 §13.1.2): `*` or any listed tag equal to ours,
/// ignoring the `W/` prefix.
pub fn not_modified(req: &HeaderMap, etag: &str) -> bool {
    let Some(v) = req.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let ours = etag.trim_start_matches("W/");
    v.split(',').any(|t| {
        let t = t.trim();
        t == "*" || t.trim_start_matches("W/") == ours
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_brotli_then_gzip_then_identity() {
        assert_eq!(
            pick(Some("gzip, deflate, br, zstd"), true, true),
            Encoding::Brotli
        );
        assert_eq!(pick(Some("gzip, deflate"), true, true), Encoding::Gzip);
        assert_eq!(pick(Some("br"), false, true), Encoding::Identity);
        assert_eq!(pick(None, true, true), Encoding::Identity);
        assert_eq!(pick(Some("identity"), true, true), Encoding::Identity);
    }

    #[test]
    fn honors_q_values_and_wildcards() {
        assert_eq!(pick(Some("br;q=0, gzip"), true, true), Encoding::Gzip);
        assert_eq!(
            pick(Some("br;q=0.5, gzip;q=0.9"), true, true),
            Encoding::Gzip
        );
        assert_eq!(pick(Some("*"), true, true), Encoding::Brotli);
        assert_eq!(pick(Some("*;q=0"), true, true), Encoding::Identity);
        assert_eq!(pick(Some("gzip;q=0, *"), false, true), Encoding::Identity);
    }

    #[test]
    fn if_none_match_uses_weak_comparison() {
        let tag = etag_of(b"hello");
        let mut h = HeaderMap::new();
        assert!(!not_modified(&h, &tag));
        h.insert(header::IF_NONE_MATCH, tag.parse().unwrap());
        assert!(not_modified(&h, &tag));
        let strong = tag.trim_start_matches("W/").to_string();
        h.insert(
            header::IF_NONE_MATCH,
            format!("\"other\", {strong}").parse().unwrap(),
        );
        assert!(not_modified(&h, &tag));
        h.insert(header::IF_NONE_MATCH, "*".parse().unwrap());
        assert!(not_modified(&h, &tag));
        h.insert(header::IF_NONE_MATCH, "W/\"0000\"".parse().unwrap());
        assert!(!not_modified(&h, &tag));
    }

    #[test]
    fn respond_negotiates_and_returns_304() {
        let v = Variants::compressed(Bytes::from("<p>hi</p>\n".repeat(300)));
        assert!(v.gzip.is_some() && v.brotli.is_some());
        let mut h = HeaderMap::new();
        h.insert(header::ACCEPT_ENCODING, "gzip, br".parse().unwrap());
        let r = v.respond(&h, Response::builder(), 200);
        assert_eq!(r.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(r.headers()[header::VARY], "Accept-Encoding");
        h.insert(header::IF_NONE_MATCH, v.etag.parse().unwrap());
        let r = v.respond(&h, Response::builder(), 200);
        assert_eq!(r.status(), StatusCode::NOT_MODIFIED);
        assert!(r.headers().get(header::CONTENT_ENCODING).is_none());
        // Non-200 responses (an ISR 404 page) are never turned into a 304.
        let r = v.respond(&h, Response::builder(), 404);
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn small_bodies_are_not_compressed() {
        let v = Variants::compressed(Bytes::from_static(b"<p>hi</p>"));
        assert!(v.gzip.is_none() && v.brotli.is_none());
    }
}
