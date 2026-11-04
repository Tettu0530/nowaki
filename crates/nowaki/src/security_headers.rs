//! Response headers `nowaki dev` / `nowaki start` add unless the response already sets them
//! (ISR hits and static assets included). `NOWAKI_SECURITY_HEADERS=off` turns them off.
//! Mirrors `packages/nowaki-runtime/server/security-headers.mjs` for the adapters.

use std::sync::OnceLock;

use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::Response;

pub const DEFAULTS: [(&str, &str); 4] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "SAMEORIGIN"),
    ("referrer-policy", "strict-origin-when-cross-origin"),
    ("cross-origin-opener-policy", "same-origin"),
];
/// Only when the app sends no CSP of its own; it restricts framing and nothing else.
pub const FRAME_CSP: &str = "frame-ancestors 'self'";

fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        !std::env::var("NOWAKI_SECURITY_HEADERS")
            .map(|v| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "0" | "off" | "false" | "no"
                )
            })
            .unwrap_or(false)
    })
}

pub fn fill(headers: &mut HeaderMap) {
    for (name, value) in DEFAULTS {
        let name = HeaderName::from_static(name);
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    let csp = HeaderName::from_static("content-security-policy");
    if !headers.contains_key(&csp) {
        headers.insert(csp, HeaderValue::from_static(FRAME_CSP));
    }
}

/// `axum::middleware::map_response` layer for both servers.
pub async fn add(mut resp: Response) -> Response {
    if enabled() {
        fill(resp.headers_mut());
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_missing_headers() {
        let mut h = HeaderMap::new();
        fill(&mut h);
        assert_eq!(h["x-content-type-options"], "nosniff");
        assert_eq!(h["x-frame-options"], "SAMEORIGIN");
        assert_eq!(h["referrer-policy"], "strict-origin-when-cross-origin");
        assert_eq!(h["cross-origin-opener-policy"], "same-origin");
        assert_eq!(h["content-security-policy"], FRAME_CSP);
    }

    #[test]
    fn keeps_headers_the_app_set() {
        let mut h = HeaderMap::new();
        h.insert("x-frame-options", HeaderValue::from_static("DENY"));
        h.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'self'"),
        );
        fill(&mut h);
        assert_eq!(h["x-frame-options"], "DENY");
        assert_eq!(h["content-security-policy"], "default-src 'self'");
        assert_eq!(h.get_all("x-frame-options").iter().count(), 1);
    }
}
