//! Mirrors `packages/nowaki-runtime/server/multipart.mjs` `FORM_BODY_LIMIT` for the Rust front.
//! Rejects oversized `multipart/form-data` before buffering the body so a lying `Content-Length`
//! cannot hold the proxy until the client times out.
//!
//! Status codes on the Rust→sidecar hop: a body over a limit is 413 (`Content-Length` over the
//! multipart cap or the proxy cap, or a streamed body that grows past the proxy cap); a body that
//! fails to read for another reason (the client aborted, a malformed chunked encoding) is 400.

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

pub fn payload_too_large() -> (StatusCode, &'static str) {
    (StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large")
}

/// 413 before reading the body: a multipart `Content-Length` over the form cap, or any
/// `Content-Length` over the proxy cap (`to_bytes` would stop there anyway).
pub fn reject_before_read(headers: &HeaderMap) -> Option<(StatusCode, &'static str)> {
    let len = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let over_proxy = len.is_some_and(|n| n > proxy_body_limit() as u64);
    (over_proxy || multipart_content_length_over_limit(headers)).then(payload_too_large)
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

/// Maps an `axum::body::to_bytes` failure: the proxy cap → 413 (whatever the content type), any
/// other read error → 400.
pub fn proxy_body_to_bytes_error(err: &axum::Error) -> (StatusCode, &'static str) {
    if is_length_limit_error(err) {
        payload_too_large()
    } else {
        (StatusCode::BAD_REQUEST, "Bad Request")
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

    #[test]
    fn content_length_over_a_cap_is_413_before_reading() {
        let proxy = proxy_body_limit() as u64;
        let form = form_body_limit();
        let over_proxy = (proxy + 1).to_string();
        let over_form = (form + 1).to_string();
        for ct in [
            "application/json",
            "application/x-www-form-urlencoded",
            "text/plain",
        ] {
            let h = map(&[("content-type", ct), ("content-length", &over_proxy)]);
            assert_eq!(
                reject_before_read(&h),
                Some((StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large")),
                "{ct}"
            );
            let h = map(&[("content-type", ct), ("content-length", &proxy.to_string())]);
            assert_eq!(reject_before_read(&h), None, "{ct} at the proxy cap");
        }
        let h = map(&[
            ("content-type", "multipart/form-data; boundary=x"),
            ("content-length", &over_form),
        ]);
        assert_eq!(
            reject_before_read(&h).map(|r| r.0),
            Some(StatusCode::PAYLOAD_TOO_LARGE)
        );
        assert_eq!(reject_before_read(&map(&[])), None, "no Content-Length");
    }

    async fn read(body: axum::body::Body, limit: usize) -> (StatusCode, &'static str) {
        let err = axum::body::to_bytes(body, limit).await.unwrap_err();
        proxy_body_to_bytes_error(&err)
    }

    #[tokio::test]
    async fn a_streamed_body_over_the_cap_is_413_and_a_broken_one_400() {
        // Over the cap without a Content-Length (chunked): 413 for every content type.
        let big = axum::body::Body::from(vec![b'x'; 64]);
        assert_eq!(
            read(big, 16).await,
            (StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large")
        );
        // The client went away mid-body: not a size problem.
        let chunks: Vec<Result<&'static [u8], std::io::Error>> = vec![
            Ok(b"partial"),
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "reset",
            )),
        ];
        let broken = axum::body::Body::from_stream(futures_util::stream::iter(chunks));
        assert_eq!(
            read(broken, 1024).await,
            (StatusCode::BAD_REQUEST, "Bad Request")
        );
    }
}
