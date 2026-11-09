//! Request headers the Rust front passes on to the Node sidecar.
//!
//! The sidecar trusts `x-forwarded-host` (the server-function same-origin check) and reads internal
//! `x-nowaki-*` headers, so neither may come from the client unchecked. Client-sent
//! forwarding headers are honored only with `NOWAKI_TRUST_PROXY=1`, for a reverse proxy that sets them.

use std::sync::OnceLock;

use axum::http::{header, HeaderMap, HeaderName};

/// Never proxied from a client: sidecar-only endpoints Rust calls itself (the sidecar trusts
/// `live-render` bodies: state to re-render, the request context for `getContext()`; `dev-info`
/// lists app files; `isr-urls` lists ISR pages and renders `staticPaths`), and the dev MCP path,
/// which only `nowaki dev` mounts (loopback-only).
const INTERNAL_PATHS: [&str; 4] = [
    "/__nowaki/live-render",
    "/__nowaki/dev-info",
    "/__nowaki/isr-urls",
    "/__nowaki/mcp",
];

pub fn is_internal_path(path: &str) -> bool {
    INTERNAL_PATHS.iter().any(|p| {
        path.strip_prefix(p)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// `x-nowaki-*` request headers the browser runtime sends on purpose; every other one is internal
/// (`x-nowaki-route-path` among them: the front sets it after this filter, `front.rs`).
const CLIENT_NOWAKI_HEADERS: [&str; 3] = ["x-nowaki-rpc", "x-nowaki-nav", "x-nowaki-live"];

pub fn trust_proxy() -> bool {
    static TRUST: OnceLock<bool> = OnceLock::new();
    *TRUST.get_or_init(|| {
        std::env::var("NOWAKI_TRUST_PROXY")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
    })
}

fn first_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let v = headers.get(name)?.to_str().ok()?;
    let first = v.split(',').next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// The host the browser addressed: the proxy's `x-forwarded-host` when trusted, else `Host`.
pub fn public_host(headers: &HeaderMap, trust: bool) -> Option<String> {
    if trust {
        if let Some(h) = first_value(headers, "x-forwarded-host") {
            return Some(h);
        }
    }
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// `https` only when a trusted proxy says so; the Rust server itself speaks plain HTTP.
pub fn public_proto(headers: &HeaderMap, trust: bool) -> &'static str {
    if trust && first_value(headers, "x-forwarded-proto").as_deref() == Some("https") {
        "https"
    } else {
        "http"
    }
}

/// Whether a client request header may be passed to the sidecar as-is.
pub fn passes(name: &HeaderName, trust: bool) -> bool {
    let n = name.as_str();
    if name == header::HOST || n == "forwarded" || n == "x-real-ip" {
        return false;
    }
    if n.starts_with("x-forwarded-") {
        // Host and proto are re-set canonically; a trusted proxy's client-IP chain is kept.
        return trust && n == "x-forwarded-for";
    }
    !n.starts_with("x-nowaki-") || CLIENT_NOWAKI_HEADERS.contains(&n)
}

/// Copy the client's headers onto a sidecar request, minus the ones it must not control, plus
/// canonical `x-forwarded-host` / `x-forwarded-proto`.
pub fn apply(
    mut builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
    trust: bool,
) -> reqwest::RequestBuilder {
    for (name, value) in headers.iter() {
        if passes(name, trust) {
            builder = builder.header(name, value);
        }
    }
    if let Some(host) = public_host(headers, trust) {
        builder = builder.header("x-forwarded-host", host);
    }
    builder.header("x-forwarded-proto", public_proto(headers, trust))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn untrusted_forwarding_headers_are_ignored() {
        let h = map(&[
            ("host", "app.example"),
            ("x-forwarded-host", "evil.test"),
            ("x-forwarded-proto", "https"),
        ]);
        assert_eq!(public_host(&h, false).as_deref(), Some("app.example"));
        assert_eq!(public_proto(&h, false), "http");
        for n in [
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-forwarded-for",
            "forwarded",
            "x-real-ip",
            "host",
        ] {
            assert!(
                !passes(&HeaderName::from_static(n), false),
                "{n} must not pass"
            );
        }
    }

    #[test]
    fn trusted_proxy_headers_use_the_first_hop() {
        let h = map(&[
            ("host", "10.0.0.5:3000"),
            ("x-forwarded-host", "app.example, inner.proxy"),
            ("x-forwarded-proto", "https,http"),
        ]);
        assert_eq!(public_host(&h, true).as_deref(), Some("app.example"));
        assert_eq!(public_proto(&h, true), "https");
        assert!(passes(&HeaderName::from_static("x-forwarded-for"), true));
        assert!(!passes(&HeaderName::from_static("x-forwarded-host"), true));
    }

    #[test]
    fn trusted_without_forwarded_host_falls_back_to_host() {
        let h = map(&[("host", "app.example")]);
        assert_eq!(public_host(&h, true).as_deref(), Some("app.example"));
        assert_eq!(public_proto(&h, true), "http");
    }

    #[test]
    fn only_client_facing_nowaki_headers_pass() {
        for n in [
            "x-nowaki-rpc",
            "x-nowaki-nav",
            "x-nowaki-live",
            "content-type",
            "cookie",
            "origin",
        ] {
            assert!(passes(&HeaderName::from_static(n), false), "{n} must pass");
        }
        for n in [
            "x-nowaki-ssr-version",
            "x-nowaki-page",
            "x-nowaki-vary",
            "x-nowaki-revalidate",
            // Set by the front for rewrites / basePath; a client value would pick the route.
            crate::front::ROUTE_PATH_HEADER,
        ] {
            assert!(
                !passes(&HeaderName::from_static(n), false),
                "{n} must not pass"
            );
        }
    }

    #[test]
    fn live_render_is_internal() {
        assert!(is_internal_path("/__nowaki/live-render"));
        assert!(is_internal_path("/__nowaki/live-render/x"));
        assert!(!is_internal_path("/__nowaki/live"));
        assert!(!is_internal_path("/__nowaki/live-render-not"));
        assert!(!is_internal_path("/__nowaki/fn"));
        assert!(is_internal_path("/__nowaki/dev-info"));
        assert!(is_internal_path("/__nowaki/isr-urls"));
        assert!(is_internal_path("/__nowaki/mcp"));
        assert!(!is_internal_path("/__nowaki/mcpx"));
    }
}
