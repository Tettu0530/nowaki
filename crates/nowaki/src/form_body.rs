//! Mirrors `packages/nowaki-runtime/server/multipart.mjs` `FORM_BODY_LIMIT` for the Rust front.
//! Rejects oversized `multipart/form-data` before buffering the body so a lying `Content-Length`
//! cannot hold the proxy until the client times out.

use std::error::Error as StdError;
use std::sync::OnceLock;

use axum::http::{header, HeaderMap, StatusCode};

const DEFAULT_LIMIT: u64 = 10 * 1024 * 1024;
const LEGACY_PROXY_FLOOR: u64 = 16 * 1024 * 1024;

/// Max bytes buffered on the Rust→sidecar hop (at least 16 MiB for general SSR, or `NOWAKI_FORM_BODY_LIMIT` when larger).
pub fn proxy_body_limit() -> usize {
    std::cmp::max(LEGACY_PROXY_FLOOR, form_body_limit()) as usize
}

pub fn form_body_limit() -> u64 {
    static LIMIT: OnceLock<u64> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        std::env::var("NOWAKI_FORM_BODY_LIMIT")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&n| n > 0)
            .unwrap_or(DEFAULT_LIMIT)
    })
}

pub fn is_multipart_form_data(ct: &str) -> bool {
    const PREFIX: &str = "multipart/form-data";
    let bytes = ct.as_bytes();
    if bytes.len() < PREFIX.len() {
        return false;
    }
    if !bytes[..PREFIX.len()].eq_ignore_ascii_case(PREFIX.as_bytes()) {
        return false;
    }
    if bytes.len() == PREFIX.len() {
        return true;
    }
    let b = bytes[PREFIX.len()];
    !b.is_ascii_alphanumeric() && b != b'_'
}

/// True when `Content-Length` exceeds the multipart cap (same gate as `ctx.formData()` on Node).
pub fn multipart_content_length_over_limit(headers: &HeaderMap) -> bool {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !is_multipart_form_data(ct) {
        return false;
    }
    let len = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    len.is_some_and(|n| n > form_body_limit())
}

pub fn multipart_payload_too_large() -> (StatusCode, &'static str) {
    (StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large")
}

/// When `to_bytes` hits the proxy cap: multipart → 413, everything else → 400.
pub fn proxy_body_overflow_response(headers: &HeaderMap) -> (StatusCode, &'static str) {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if is_multipart_form_data(ct) {
        multipart_payload_too_large()
    } else {
        (StatusCode::BAD_REQUEST, "request body too large.")
    }
}

fn is_length_limit_error(err: &axum::Error) -> bool {
    let mut cur = err.source();
    while let Some(e) = cur {
        if e.downcast_ref::<http_body_util::LengthLimitError>()
            .is_some()
        {
            return true;
        }
        cur = e.source();
    }
    false
}

/// Map `axum::body::to_bytes` failures: 413 only for length-limit hits on multipart.
pub fn proxy_body_to_bytes_error(
    headers: &HeaderMap,
    err: &axum::Error,
) -> (StatusCode, &'static str) {
    if is_length_limit_error(err) {
        proxy_body_overflow_response(headers)
    } else {
        (StatusCode::BAD_REQUEST, "request body too large.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn map(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn multipart_over_limit() {
        let limit = form_body_limit();
        let h = map(&[
            ("content-type", "multipart/form-data; boundary=x"),
            ("content-length", &(limit + 1).to_string()),
        ]);
        assert!(multipart_content_length_over_limit(&h));
    }

    #[test]
    fn multipart_at_limit_ok() {
        let limit = form_body_limit();
        let h = map(&[
            ("content-type", "multipart/form-data; boundary=x"),
            ("content-length", &limit.to_string()),
        ]);
        assert!(!multipart_content_length_over_limit(&h));
    }

    #[test]
    fn non_multipart_ignored() {
        let h = map(&[
            ("content-type", "application/json"),
            ("content-length", "999999999"),
        ]);
        assert!(!multipart_content_length_over_limit(&h));
    }
}
