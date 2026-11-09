//! nowaki.config routing (`basePath`, `trailingSlash`, `redirects`, `rewrites`, `headers`) at
//! the Rust fronts (`nowaki start`, `nowaki dev`), compiled once from `dist/server/routing.json`
//! (dev: `.nowaki/routing.json`) by `nowaki_core::rules`. Without that file the fronts hold
//! `None` and do no per-request work.
//!
//! A request becomes a response (a redirect, or a 404 outside basePath) or goes on with the path
//! it routes by. When that differs from the browser's path (basePath removed, a rewrite), the
//! sidecar gets it in [`ROUTE_PATH_HEADER`]; `forward::apply` drops any client value of it.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use nowaki_core::rules::{Outcome, RoutingConfig, Rules};

/// Internal request header: the path the sidecar routes by (`info.routePath`).
pub const ROUTE_PATH_HEADER: &str = "x-nowaki-route-path";

pub struct Front {
    rules: Rules,
    has_headers: bool,
}

pub enum Step {
    Respond(Response),
    /// Go on; `Some` is the route path when it differs from the browser's path.
    Continue(Option<String>),
}

/// The compiled rules from a routing.json, or `None` when there is no file or nothing to check
/// per request (i18n alone, say).
pub fn load(file: &Path) -> Result<Option<Arc<Front>>> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("failed to read {}", file.display())),
    };
    let config: RoutingConfig = serde_json::from_str(&text)
        .with_context(|| format!("{} is not a valid routing config", file.display()))?;
    let rules = Rules::compile(&config).map_err(|e| anyhow!("{}: {e}", file.display()))?;
    if rules.is_empty() {
        return Ok(None);
    }
    Ok(Some(Arc::new(Front {
        rules,
        has_headers: !config.headers.is_empty(),
    })))
}

/// Framework URLs no rule applies to: `/__nowaki/*` endpoints and `/_nowaki/*` assets, which
/// are served at the root until asset URLs carry basePath.
fn bypassed(path: &str) -> bool {
    path.starts_with("/_nowaki/") || path.starts_with("/__nowaki/") || path == "/__nowaki"
}

impl Front {
    pub fn apply(&self, method: &Method, uri: &Uri) -> Step {
        let path = uri.path();
        if bypassed(path) {
            return Step::Continue(None);
        }
        match self.rules.apply(method.as_str(), path) {
            Outcome::Pass(p) | Outcome::Rewrite(p) => Step::Continue((p != path).then_some(p)),
            Outcome::Redirect { status, location } => {
                Step::Respond(redirect(status, &location, uri.query()))
            }
            Outcome::NotFound => {
                Step::Respond((StatusCode::NOT_FOUND, "not found").into_response())
            }
        }
    }

    /// Whether any `headers` rule exists (the response layer is installed only then).
    pub fn has_headers(&self) -> bool {
        self.has_headers
    }

    /// The URL a browser uses for a route path: basePath in front, a trailing slash under
    /// `trailingSlash: "always"` (not after a file name). For requests the CLI makes itself.
    pub fn browser_path(&self, route: &str) -> String {
        self.rules.browser_path(route, false)
    }

    /// Fills the config headers for the browser path `path` into a response, keeping any the
    /// response already set (they run before the default security headers, so they win over those).
    /// None for the framework's `/__nowaki/*` endpoints (a catch-all `cache-control` must not reach
    /// RPC or live responses).
    pub fn fill_headers(&self, path: &str, headers: &mut axum::http::HeaderMap) {
        if path.starts_with("/__nowaki/") {
            return;
        }
        for (name, value) in self.rules.headers(path) {
            let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) else {
                continue;
            };
            if !headers.contains_key(&name) {
                headers.insert(name, value);
            }
        }
    }
}

/// `axum::middleware::from_fn_with_state` layer applying the `headers` rules to every response
/// (pages, ISR hits, static and public files, 304s, redirects).
pub async fn headers_layer(State(front): State<Arc<Front>>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;
    front.fill_headers(&path, resp.headers_mut());
    resp
}

/// The request's query goes along to the redirect target (after one the destination wrote, before
/// a fragment).
pub fn with_query(location: &str, query: Option<&str>) -> String {
    let Some(q) = query.filter(|q| !q.is_empty()) else {
        return location.to_string();
    };
    let (head, fragment) = location.split_at(location.find('#').unwrap_or(location.len()));
    let sep = if head.contains('?') { '&' } else { '?' };
    format!("{head}{sep}{q}{fragment}")
}

fn redirect(status: u16, location: &str, query: Option<&str>) -> Response {
    let location = with_query(location, query);
    // The location is percent-encoded or a config literal checked at build; a value that still
    // isn't a valid header is refused rather than sent.
    let (Ok(value), Ok(status)) = (
        HeaderValue::from_str(&location),
        StatusCode::from_u16(status),
    ) else {
        return (StatusCode::BAD_REQUEST, "bad request").into_response();
    };
    Response::builder()
        .status(status)
        .header(header::LOCATION, value)
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn front(json: &str) -> Option<Arc<Front>> {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("routing.json");
        std::fs::write(&file, json).unwrap();
        load(&file).unwrap()
    }

    fn step(f: &Front, method: Method, uri: &str) -> Step {
        f.apply(&method, &uri.parse().unwrap())
    }

    fn location(s: Step) -> (u16, String) {
        match s {
            Step::Respond(r) => (
                r.status().as_u16(),
                r.headers()
                    .get(header::LOCATION)
                    .map(|v| v.to_str().unwrap().to_string())
                    .unwrap_or_default(),
            ),
            Step::Continue(p) => panic!("expected a response, got Continue({p:?})"),
        }
    }

    fn route(s: Step) -> Option<String> {
        match s {
            Step::Continue(p) => p,
            Step::Respond(r) => panic!("expected Continue, got {}", r.status()),
        }
    }

    #[test]
    fn no_file_or_nothing_to_check_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(&dir.path().join("routing.json")).unwrap().is_none());
        assert!(front("{}").is_none());
        assert!(front(r#"{"i18n":{"locales":["en"],"defaultLocale":"en"}}"#).is_none());
    }

    #[test]
    fn an_invalid_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("routing.json");
        std::fs::write(
            &file,
            r#"{"redirects":[{"source":"x","destination":"/y"}]}"#,
        )
        .unwrap();
        assert!(load(&file).is_err());
        std::fs::write(&file, "not json").unwrap();
        assert!(load(&file).is_err());
    }

    #[test]
    fn redirects_carry_the_query() {
        let f = front(
            r#"{"redirects":[
                {"source":"/old/[...rest]","destination":"/new/[...rest]","status":308},
                {"source":"/q","destination":"/x?a=1#top","status":307},
                {"source":"/ext","destination":"https://example.com/path","status":302}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            location(step(&f, Method::GET, "/old/a/b?x=1&y=2")),
            (308, "/new/a/b?x=1&y=2".into())
        );
        assert_eq!(
            location(step(&f, Method::GET, "/q?b=2")),
            (307, "/x?a=1&b=2#top".into())
        );
        assert_eq!(
            location(step(&f, Method::GET, "/q")),
            (307, "/x?a=1#top".into())
        );
        assert_eq!(
            location(step(&f, Method::POST, "/ext?z")),
            (302, "https://example.com/path?z".into())
        );
    }

    #[test]
    fn open_redirects_stay_on_the_site() {
        let f = front(
            r#"{"redirects":[
                {"source":"/old/[...rest]","destination":"/[...rest]","status":308},
                {"source":"/go/[to]","destination":"/[to]","status":307}
            ]}"#,
        )
        .unwrap();
        for (uri, want) in [
            ("/old//evil.com", "/evil.com"),
            ("/old/%2F%2Fevil.com", "/%2F%2Fevil.com"),
            ("/go/%5C%5Cevil.com", "/%5C%5Cevil.com"),
            (
                "/go/a%0D%0ASet-Cookie:%20x=1",
                "/a%0D%0ASet-Cookie%3A%20x%3D1",
            ),
        ] {
            assert_eq!(location(step(&f, Method::GET, uri)).1, want, "{uri}");
        }
    }

    #[test]
    fn base_path_rewrites_and_trailing_slash() {
        let f = front(
            r#"{"basePath":"/app","trailingSlash":"never",
                "rewrites":[{"source":"/p/[id]","destination":"/photo/[id]"}]}"#,
        )
        .unwrap();
        assert_eq!(
            route(step(&f, Method::GET, "/app/about")),
            Some("/about".into())
        );
        assert_eq!(route(step(&f, Method::GET, "/app")), Some("/".into()));
        assert_eq!(
            route(step(&f, Method::GET, "/app/p/7")),
            Some("/photo/7".into())
        );
        assert_eq!(
            location(step(&f, Method::GET, "/app/about/?x=1")),
            (308, "/app/about?x=1".into())
        );
        // A form posted to /about/ keeps working.
        assert_eq!(
            route(step(&f, Method::POST, "/app/about/")),
            Some("/about/".into())
        );
        assert_eq!(location(step(&f, Method::GET, "/about")).0, 404);
        // Framework URLs are never matched (assets stay at the root for now).
        assert_eq!(route(step(&f, Method::GET, "/_nowaki/x.js")), None);
        assert_eq!(route(step(&f, Method::POST, "/__nowaki/fn")), None);
        assert_eq!(
            route(step(&f, Method::GET, "/app/_nowaki/x.js")),
            Some("/_nowaki/x.js".into())
        );
    }

    #[test]
    fn same_path_is_continue_none() {
        let f = front(r#"{"redirects":[{"source":"/a","destination":"/b"}]}"#).unwrap();
        assert_eq!(route(step(&f, Method::GET, "/about")), None);
    }

    #[test]
    fn browser_paths_for_cli_requests() {
        let f = front(r#"{"basePath":"/app","trailingSlash":"always"}"#).unwrap();
        assert_eq!(f.browser_path("/"), "/app/");
        assert_eq!(f.browser_path("/about"), "/app/about/");
        assert_eq!(f.browser_path("/feed.xml"), "/app/feed.xml");
        let f = front(r#"{"basePath":"/app"}"#).unwrap();
        assert_eq!(f.browser_path("/"), "/app");
        assert_eq!(f.browser_path("/about"), "/app/about");
        let f = front(r#"{"trailingSlash":"always"}"#).unwrap();
        assert_eq!(f.browser_path("/"), "/");
        assert_eq!(f.browser_path("/a/b"), "/a/b/");
    }

    #[test]
    fn header_rules_fill_but_never_replace() {
        let f = front(
            r#"{"headers":[
                {"source":"/api/[...rest]","headers":[{"key":"Cache-Control","value":"no-store"},{"key":"x-frame-options","value":"DENY"}]}
            ]}"#,
        )
        .unwrap();
        assert!(f.has_headers());
        let mut h = axum::http::HeaderMap::new();
        h.insert("cache-control", HeaderValue::from_static("max-age=5"));
        f.fill_headers("/api/x", &mut h);
        assert_eq!(h["cache-control"], "max-age=5");
        assert_eq!(h["x-frame-options"], "DENY");
        let mut other = axum::http::HeaderMap::new();
        f.fill_headers("/about", &mut other);
        assert!(other.is_empty());
        // The security defaults come after, so a rule's value wins over theirs.
        crate::security_headers::fill(&mut h);
        assert_eq!(h["x-frame-options"], "DENY");
    }

    #[test]
    fn framework_endpoints_get_no_config_headers() {
        let f = front(
            r#"{"headers":[{"source":"/[...all]","headers":[{"key":"cache-control","value":"public, max-age=3600"}]}]}"#,
        )
        .unwrap();
        let mut fn_resp = axum::http::HeaderMap::new();
        f.fill_headers("/__nowaki/fn", &mut fn_resp);
        assert!(fn_resp.is_empty());
        let mut asset = axum::http::HeaderMap::new();
        f.fill_headers("/_nowaki/a.js", &mut asset);
        assert_eq!(asset["cache-control"], "public, max-age=3600");
    }
}
