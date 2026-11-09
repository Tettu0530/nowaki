//! nowaki.config routing (`basePath`, `trailingSlash`, `redirects`, `rewrites`, `headers`,
//! `i18n.detect`) at the Rust fronts (`nowaki start`, `nowaki dev`), compiled once from
//! `dist/server/routing.json` (dev: `.nowaki/routing.json`) by `nowaki_core::rules`. Without that
//! file the fronts hold `None` and do no per-request work.
//!
//! A request becomes a response (a redirect, or a 404 outside basePath) or goes on with the path
//! it routes by. When that differs from the browser's path (basePath removed, a rewrite), the
//! sidecar gets it in [`ROUTE_PATH_HEADER`]; `forward::apply` drops any client value of it.
//!
//! Locale detection (`i18n.detect`) runs in [`headers_layer`], ahead of the handlers and so of the
//! ISR lookup: a GET / HEAD of the site's root redirects (307) to the locale Accept-Language or the
//! `nowaki_locale` cookie picks, or goes on to the default locale's page; every such response
//! varies on `Accept-Language, Cookie`. The cached root therefore only ever answers visitors who
//! stay on it.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use nowaki_core::rules::{Negotiated, Outcome, RoutingConfig, Rules, TrailingSlash};

/// Internal request header: the path the sidecar routes by (`info.routePath`).
pub const ROUTE_PATH_HEADER: &str = "x-nowaki-route-path";

pub struct Front {
    rules: Rules,
    trailing: TrailingSlash,
    has_headers: bool,
}

/// The Vary of every response to the site's root under `i18n.detect`.
const LOCALE_VARY: [&str; 2] = ["Accept-Language", "Cookie"];

pub enum Step {
    Respond(Response),
    /// Go on; `Some` is the route path when it differs from the browser's path.
    Continue(Option<String>),
}

/// The compiled rules from a routing.json, or `None` when there is no file or nothing to check
/// per request (i18n without `detect`, say).
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
        trailing: config.trailing_slash,
        has_headers: !config.headers.is_empty(),
    })))
}

/// Framework URLs at the root no rule applies to: `/__nowaki/*` endpoints (they also answer under
/// basePath, see [`Front::framework_path`]) and, without a basePath, `/_nowaki/*` assets. Under a
/// basePath the assets live at `<base>/_nowaki/*` only.
fn bypassed(path: &str, base: &str) -> bool {
    path.starts_with("/__nowaki/")
        || path == "/__nowaki"
        || (base.is_empty() && path.starts_with("/_nowaki/"))
}

fn is_framework(path: &str) -> bool {
    path.starts_with("/_nowaki/") || path.starts_with("/__nowaki/") || path == "/__nowaki"
}

impl Front {
    pub fn apply(&self, method: &Method, uri: &Uri) -> Step {
        let path = uri.path();
        // Ahead of the rules: a catch-all rewrite or the trailing-slash policy must never move them.
        if let Some(p) = self.framework_path(path) {
            return Step::Continue(Some(p.to_string()));
        }
        if bypassed(path, self.rules.base_path()) {
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

    /// Under basePath, a framework URL below it (`<base>/_nowaki/*` assets, `<base>/__nowaki/*`
    /// endpoints) as the root path the server answers it at.
    pub fn framework_path<'a>(&self, path: &'a str) -> Option<&'a str> {
        let base = self.rules.base_path();
        if base.is_empty() {
            return None;
        }
        path.strip_prefix(base).filter(|rest| is_framework(rest))
    }

    /// nowaki.config `basePath` (`""` without one).
    pub fn base_path(&self) -> &str {
        self.rules.base_path()
    }

    /// Whether a basePath is set (the [`base_layer`] is installed only then).
    pub fn has_base(&self) -> bool {
        !self.rules.base_path().is_empty()
    }

    /// Whether [`headers_layer`] has work to do (header rules or locale detection); it is
    /// installed only then.
    pub fn has_response_layer(&self) -> bool {
        self.has_headers || self.rules.detects()
    }

    /// Locale detection's redirect for a request it applies to, after the rules let it through
    /// (their redirects and 404s answer first, in the handler).
    fn locale_redirect(&self, method: &Method, uri: &Uri, headers: &HeaderMap) -> Option<Response> {
        let path = uri.path();
        if !matches!(
            self.rules.apply(method.as_str(), path),
            Outcome::Pass(_) | Outcome::Rewrite(_)
        ) {
            return None;
        }
        let accept_language = joined(headers, header::ACCEPT_LANGUAGE, ", ");
        let cookie = joined(headers, header::COOKIE, "; ");
        match self.rules.negotiate(
            method.as_str(),
            path,
            accept_language.as_deref(),
            cookie.as_deref(),
        )? {
            Negotiated::Stay => None,
            Negotiated::Redirect(location) => {
                let mut resp = redirect(307, &location, uri.query());
                resp.headers_mut().insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("private, no-cache"),
                );
                Some(resp)
            }
        }
    }

    /// The URL a browser uses for a route path: basePath in front, a trailing slash under
    /// `trailingSlash: "always"` (not after a file name). For requests the CLI makes itself.
    pub fn browser_path(&self, route: &str) -> String {
        let base = self.rules.base_path();
        let mut out = if route == "/" && !base.is_empty() {
            base.to_string()
        } else {
            format!("{base}{route}")
        };
        if self.trailing == TrailingSlash::Always && !out.ends_with('/') {
            let last = route.rsplit('/').next().unwrap_or("");
            if route == "/" || !last.contains('.') {
                out.push('/');
            }
        }
        out
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
/// (pages, ISR hits, static and public files, 304s, redirects), and locale detection
/// (`i18n.detect`) to the site's root ahead of the handlers. Installed when
/// [`Front::has_response_layer`].
pub async fn headers_layer(State(front): State<Arc<Front>>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let detect = front.rules.negotiates(req.method().as_str(), &path);
    let mut resp = match detect
        .then(|| front.locale_redirect(req.method(), req.uri(), req.headers()))
        .flatten()
    {
        Some(resp) => resp,
        None => next.run(req).await,
    };
    front.fill_headers(&path, resp.headers_mut());
    if detect {
        add_vary(resp.headers_mut());
    }
    resp
}

/// A request header's values joined into one (`None` without a readable one).
fn joined(headers: &HeaderMap, name: HeaderName, sep: &str) -> Option<String> {
    let values: Vec<&str> = headers
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    (!values.is_empty()).then(|| values.join(sep))
}

/// Adds `Accept-Language, Cookie` to a response's Vary, unless it names them already or is `*`.
fn add_vary(headers: &mut HeaderMap) {
    let existing: Vec<String> = headers
        .get_all(header::VARY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(str::to_string)
        .collect();
    let list = existing.join(", ");
    let have: Vec<String> = list
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .collect();
    if have.iter().any(|s| s == "*") {
        return;
    }
    let add: Vec<&str> = LOCALE_VARY
        .into_iter()
        .filter(|n| !have.contains(&n.to_ascii_lowercase()))
        .collect();
    if add.is_empty() {
        return;
    }
    let value = if list.is_empty() {
        add.join(", ")
    } else {
        format!("{list}, {}", add.join(", "))
    };
    if let Ok(v) = HeaderValue::from_str(&value) {
        headers.insert(header::VARY, v);
    }
}

/// Under basePath, moves `<base>/__nowaki/*` requests to `/__nowaki/*` before routing, so the
/// endpoints the client reaches under the base (server functions, the live socket, boundaries,
/// HMR) are the same handlers, behind the same checks (`forward::is_internal_path` included), as
/// at the root. Wraps the whole router: a `Router::layer` runs after routing.
pub async fn base_layer(State(front): State<Arc<Front>>, mut req: Request, next: Next) -> Response {
    if let Some(p) = front
        .framework_path(req.uri().path())
        .filter(|p| p.starts_with("/__nowaki"))
    {
        let pq = match req.uri().query() {
            Some(q) => format!("{p}?{q}"),
            None => p.to_string(),
        };
        let mut parts = req.uri().clone().into_parts();
        match pq.parse() {
            Ok(v) => parts.path_and_query = Some(v),
            Err(_) => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
        }
        match Uri::from_parts(parts) {
            Ok(uri) => *req.uri_mut() = uri,
            Err(_) => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
        }
    }
    next.run(req).await
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
        // Assets live under the base only; endpoints answer at the root and under the base.
        assert_eq!(location(step(&f, Method::GET, "/_nowaki/x.js")).0, 404);
        assert_eq!(route(step(&f, Method::POST, "/__nowaki/fn")), None);
        assert_eq!(
            route(step(&f, Method::GET, "/app/_nowaki/x.js")),
            Some("/_nowaki/x.js".into())
        );
        assert_eq!(
            route(step(&f, Method::POST, "/app/__nowaki/fn")),
            Some("/__nowaki/fn".into())
        );
        assert_eq!(f.framework_path("/app/__nowaki"), Some("/__nowaki"));
        assert_eq!(f.framework_path("/app/_nowakix"), None);
        assert_eq!(f.framework_path("/apple/_nowaki/x.js"), None);
        assert!(f.has_base());
    }

    #[test]
    fn framework_urls_skip_the_rules() {
        let f = front(
            r#"{"basePath":"/app","trailingSlash":"always",
                "rewrites":[{"source":"/[...all]","destination":"/catch/[...all]"}]}"#,
        )
        .unwrap();
        assert_eq!(
            route(step(&f, Method::GET, "/app/_nowaki/runtime.js")),
            Some("/_nowaki/runtime.js".into())
        );
        assert_eq!(
            route(step(&f, Method::GET, "/app/__nowaki/boundaries")),
            Some("/__nowaki/boundaries".into())
        );
        let f = front(r#"{"redirects":[{"source":"/a","destination":"/b"}]}"#).unwrap();
        assert!(!f.has_base());
        assert_eq!(f.framework_path("/_nowaki/x.js"), None);
        assert_eq!(route(step(&f, Method::GET, "/_nowaki/x.js")), None);
    }

    #[tokio::test]
    async fn the_base_layer_moves_endpoints_to_the_root() {
        use axum::routing::get;
        use tower_layer::Layer;
        use tower_service::Service;
        let f = front(r#"{"basePath":"/app"}"#).unwrap();
        let router = axum::Router::new()
            .route("/__nowaki/live", get(|| async { "live" }))
            .fallback(|uri: Uri| async move { uri.to_string() });
        let mut svc = axum::middleware::from_fn_with_state(f, base_layer).layer(router);
        for (uri, want) in [
            ("/app/__nowaki/live", "live"),
            ("/app/__nowaki/fn?x=1", "/__nowaki/fn?x=1"),
            ("/app/_nowaki/a.js", "/app/_nowaki/a.js"),
            ("/app/about", "/app/about"),
        ] {
            let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
            let resp = svc.call(req).await.unwrap();
            let bytes = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
            assert_eq!(bytes, want, "{uri}");
        }
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
        assert!(f.has_response_layer());
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

    /// Runs `uri` with `headers` through [`headers_layer`] over a router whose `/` answers "root"
    /// with `Vary: Origin`: (status, location, vary, cache-control, body).
    async fn layered(
        f: Arc<Front>,
        method: Method,
        uri: &str,
        headers: &[(&str, &str)],
    ) -> (u16, String, String, String, String) {
        use axum::routing::get;
        use tower_service::Service;
        let mut svc = axum::Router::new()
            .route("/", get(|| async { ([(header::VARY, "Origin")], "root") }))
            .fallback(|| async { "other" })
            .layer(axum::middleware::from_fn_with_state(f, headers_layer));
        let mut req = Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = svc.call(req.body(Body::empty()).unwrap()).await.unwrap();
        let h = |n: header::HeaderName| {
            resp.headers()
                .get_all(n)
                .iter()
                .map(|v| v.to_str().unwrap().to_string())
                .collect::<Vec<_>>()
                .join(" | ")
        };
        let (status, location, vary, cc) = (
            resp.status().as_u16(),
            h(header::LOCATION),
            h(header::VARY),
            h(header::CACHE_CONTROL),
        );
        let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        (
            status,
            location,
            vary,
            cc,
            String::from_utf8(body.to_vec()).unwrap(),
        )
    }

    #[tokio::test]
    async fn locale_detection_redirects_the_root_ahead_of_the_handlers() {
        let f = front(
            r#"{"i18n":{"locales":["en","ja"],"defaultLocale":"en","prefixDefaultLocale":false,"detect":true}}"#,
        )
        .unwrap();
        assert!(f.has_response_layer());
        let (status, location, vary, cc, _) = layered(
            f.clone(),
            Method::GET,
            "/?utm=1",
            &[("accept-language", "ja-JP,ja;q=0.9")],
        )
        .await;
        assert_eq!((status, location.as_str()), (307, "/ja?utm=1"));
        assert_eq!(vary, "Accept-Language, Cookie");
        assert_eq!(cc, "private, no-cache");
        // Staying on the root: the handler's response, with the locale inputs added to its Vary.
        let stay = layered(
            f.clone(),
            Method::GET,
            "/",
            &[("accept-language", "ja"), ("cookie", "nowaki_locale=en")],
        )
        .await;
        assert_eq!(stay.0, 200);
        assert_eq!(stay.2, "Origin, Accept-Language, Cookie");
        assert_eq!(stay.4, "root");
        // Repeated headers are read as one list.
        let split = layered(
            f.clone(),
            Method::GET,
            "/",
            &[
                ("accept-language", "fr"),
                ("accept-language", "ja"),
                ("cookie", "a=1"),
                ("cookie", "nowaki_locale=ja"),
            ],
        )
        .await;
        assert_eq!(split.1, "/ja");
        // Not the root, not GET / HEAD: no detection, no Vary.
        let other = layered(
            f.clone(),
            Method::GET,
            "/about",
            &[("accept-language", "ja")],
        )
        .await;
        assert_eq!((other.0, other.2.as_str()), (200, ""));
        let post = layered(f, Method::POST, "/", &[("accept-language", "ja")]).await;
        assert_eq!(post.1, "");
    }

    #[tokio::test]
    async fn config_redirects_answer_before_locale_detection() {
        let f = front(
            r#"{"redirects":[{"source":"/","destination":"/home","status":307}],
                "i18n":{"locales":["en","ja"],"defaultLocale":"en","detect":true}}"#,
        )
        .unwrap();
        // The layer leaves it to the handler (Front::apply), which redirects to /home.
        let (status, location, vary, ..) =
            layered(f.clone(), Method::GET, "/", &[("accept-language", "ja")]).await;
        assert_eq!((status, location.as_str()), (200, ""));
        assert_eq!(vary, "Origin, Accept-Language, Cookie");
        assert_eq!(
            location_of(f.apply(&Method::GET, &"/".parse().unwrap())),
            "/home"
        );
    }

    fn location_of(s: Step) -> String {
        location(s).1
    }

    #[test]
    fn vary_is_merged_once() {
        let mut h = HeaderMap::new();
        add_vary(&mut h);
        assert_eq!(h[header::VARY], "Accept-Language, Cookie");
        add_vary(&mut h);
        assert_eq!(h[header::VARY], "Accept-Language, Cookie");
        let mut h = HeaderMap::new();
        h.insert(header::VARY, HeaderValue::from_static("cookie"));
        add_vary(&mut h);
        assert_eq!(h[header::VARY], "cookie, Accept-Language");
        let mut h = HeaderMap::new();
        h.insert(header::VARY, HeaderValue::from_static("*"));
        add_vary(&mut h);
        assert_eq!(h[header::VARY], "*");
    }
}
