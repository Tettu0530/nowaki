//! Opt-in Content Security Policy with a per-response nonce (`NOWAKI_CSP=report-only|enforce`).
//!
//! The nonce goes only on the tags Nowaki rendered. The renderer writes `nonce="<marker>"` on
//! them, with a random marker per render that it names in `x-nowaki-csp-marker`; this layer turns
//! exactly those attributes into the response's nonce while the body streams, so streaming SSR
//! stays streaming. A `<script>` / `<style>` that reached the page as raw HTML can't know the
//! marker and gets no nonce. The layer wraps the ISR cache too: an entry keeps its render's marker
//! (never sent to a browser) and each response, HIT included, gets a fresh nonce. A response that
//! already sets its own CSP is left alone, minus the markers. Mirrors
//! `packages/nowaki-runtime/server/csp.mjs` and `server/nonce.mjs`.

use std::sync::OnceLock;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use futures_util::StreamExt;

/// The `NOWAKI_CSP` setting.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Off,
    ReportOnly,
    Enforce,
}

/// Reads a `NOWAKI_CSP` value the way `server/csp.mjs` `cspMode` does; anything unknown is off.
pub fn parse_mode(v: &str) -> Mode {
    match v.trim().to_ascii_lowercase().as_str() {
        "report-only" | "report" => Mode::ReportOnly,
        "enforce" | "on" | "1" | "true" => Mode::Enforce,
        _ => Mode::Off,
    }
}

pub(crate) fn mode() -> Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    *MODE.get_or_init(|| {
        std::env::var("NOWAKI_CSP")
            .map(|v| parse_mode(&v))
            .unwrap_or(Mode::Off)
    })
}

fn report_uri() -> Option<&'static str> {
    static URI: OnceLock<Option<String>> = OnceLock::new();
    URI.get_or_init(|| {
        std::env::var("NOWAKI_CSP_REPORT_URI")
            .ok()
            .filter(|s| !s.trim().is_empty())
    })
    .as_deref()
}

/// 16 random bytes as 32 lowercase hex digits.
pub fn new_nonce() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random source");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Style attributes need `style-src-attr 'unsafe-inline'`: next to a nonce, CSP3 ignores
/// 'unsafe-inline' for elements, so elements and attributes get separate directives.
pub fn policy(nonce: &str, report_uri: Option<&str>) -> String {
    let mut p = format!(
        "default-src 'self'; script-src 'self' 'nonce-{nonce}'; style-src-elem 'self' 'nonce-{nonce}'; \
style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; \
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    );
    if let Some(uri) = report_uri {
        p.push_str(&format!("; report-uri {uri}"));
    }
    p
}

/// The response header a render names its marker in (`server/nonce.mjs`). Internal: with a CSP
/// mode on, the layer removes it from every response; with it off, no render sets it.
pub const MARKER_HEADER: &str = "x-nowaki-csp-marker";

/// A marker as the runtime makes them (32 lowercase hex digits, like a nonce). Anything else is
/// ignored, so an empty or short value can never match attributes the app wrote.
pub fn valid_marker(v: &str) -> bool {
    v.len() == 32
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Replaces `nonce="<marker>"` with `to` (the response's `nonce="…"`, or nothing) across chunk
/// boundaries. Only the tags Nowaki rendered carry the marker, so nothing else gets the nonce.
pub struct Stamper {
    needle: Vec<u8>,
    to: Vec<u8>,
    carry: Vec<u8>,
}

impl Stamper {
    pub fn new(marker: &str, to: &str) -> Self {
        Self {
            needle: format!("nonce=\"{marker}\"").into_bytes(),
            to: to.as_bytes().to_vec(),
            carry: Vec::new(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        let n = self.needle.len();
        let mut out = Vec::with_capacity(data.len() + 16);
        let mut i = 0;
        while let Some(p) = find(&data[i..], &self.needle) {
            out.extend_from_slice(&data[i..i + p]);
            out.extend_from_slice(&self.to);
            i += p + n;
        }
        // A tail that could still become the marker with the next chunk waits for it.
        let rest = &data[i..];
        let keep = (1..n.min(rest.len() + 1))
            .rev()
            .find(|&k| self.needle.starts_with(&rest[rest.len() - k..]))
            .unwrap_or(0);
        out.extend_from_slice(&rest[..rest.len() - keep]);
        self.carry = rest[rest.len() - keep..].to_vec();
        out
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.carry)
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    let first = *needle.first()?;
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        let p = hay[i..=hay.len() - needle.len()]
            .iter()
            .position(|&b| b == first)?;
        if hay[i + p..].starts_with(needle) {
            return Some(i + p);
        }
        i += p + 1;
    }
    None
}

/// `axum::middleware::from_fn` layer for dev and start.
pub async fn layer(req: Request, next: Next) -> Response {
    let mode = mode();
    let mut resp = next.run(req).await;
    if mode == Mode::Off {
        return resp;
    }
    let marker = resp
        .headers_mut()
        .remove(MARKER_HEADER)
        .and_then(|v| v.to_str().ok().map(str::to_string))
        .filter(|m| valid_marker(m));
    let is_html = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/html"));
    let has_csp = resp.headers().contains_key(header::CONTENT_SECURITY_POLICY)
        || resp
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY_REPORT_ONLY);
    if !is_html || (has_csp && marker.is_none()) {
        return resp;
    }
    let (mut parts, body) = resp.into_parts();
    // With the app's own CSP there is no nonce of ours: the marked tags just lose the marker.
    let to = if has_csp {
        String::new()
    } else {
        let nonce = new_nonce();
        let name: HeaderName = match mode {
            Mode::Enforce => header::CONTENT_SECURITY_POLICY,
            _ => header::CONTENT_SECURITY_POLICY_REPORT_ONLY,
        };
        if let Ok(v) = HeaderValue::from_str(&policy(&nonce, report_uri())) {
            parts.headers.insert(name, v);
        }
        format!("nonce=\"{nonce}\"")
    };
    // Without a marker nothing in the body gets the nonce, and the body goes out as it is.
    let Some(marker) = marker else {
        return Response::from_parts(parts, body);
    };
    parts.headers.remove(header::CONTENT_LENGTH);
    let mut st = Stamper::new(&marker, &to);
    let mut done = false;
    let stream = body
        .into_data_stream()
        .map(Some)
        .chain(futures_util::stream::once(async { None }));
    let mapped = stream.filter_map(move |item| {
        let out = match item {
            Some(Ok(chunk)) => Some(Ok::<Bytes, axum::Error>(Bytes::from(st.push(&chunk)))),
            Some(Err(e)) => Some(Err(e)),
            None if !done => {
                done = true;
                Some(Ok(Bytes::from(st.finish())))
            }
            None => None,
        };
        std::future::ready(out)
    });
    Response::from_parts(parts, Body::from_stream(mapped))
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: &str = "0123456789abcdef0123456789abcdef";

    /// Runs the stamper for marker `M` with a fresh nonce; expectations use `{n}` for it.
    fn stamp(chunks: &[&str], expected: &str) {
        let n = new_nonce();
        let mut st = Stamper::new(M, &format!("nonce=\"{n}\""));
        let mut out = Vec::new();
        for c in chunks {
            out.extend(st.push(c.as_bytes()));
        }
        out.extend(st.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            expected.replace("{n}", &n).replace("{m}", M)
        );
    }

    #[test]
    fn only_marked_tags_get_the_nonce() {
        stamp(
            &[&format!(
                r#"<head><style nonce="{M}">a{{}}</style><style>raw{{}}</style><script nonce="{M}" type="module" src="/x.js"></script><SCRIPT>1</SCRIPT><script nonce="guess">2</script></head>"#
            )],
            r#"<head><style nonce="{n}">a{}</style><style>raw{}</style><script nonce="{n}" type="module" src="/x.js"></script><SCRIPT>1</SCRIPT><script nonce="guess">2</script></head>"#,
        );
    }

    #[test]
    fn a_body_without_the_marker_is_unchanged() {
        let html = r#"<script>1</script><style nonce="">a{}</style><p>nonce="x"</p>"#;
        stamp(&[html], html);
    }

    #[test]
    fn works_across_chunk_boundaries() {
        let marked =
            format!(r#"<p>a</p><script nonce="{M}">1</script><style nonce="{M}">b</style>"#);
        // Every split point, including inside the marker.
        for at in 1..marked.len() {
            stamp(
                &[&marked[..at], &marked[at..]],
                r#"<p>a</p><script nonce="{n}">1</script><style nonce="{n}">b</style>"#,
            );
        }
        stamp(&["end nonce=\"0123", "x\""], "end nonce=\"0123x\"");
        stamp(&["tail nonce=\"0123"], "tail nonce=\"0123");
    }

    #[test]
    fn stripping_leaves_no_marker() {
        let mut st = Stamper::new(M, "");
        let mut out = st.push(format!(r#"<script nonce="{M}" src="/a.js"></script>"#).as_bytes());
        out.extend(st.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"<script  src="/a.js"></script>"#
        );
    }

    #[test]
    fn markers_are_validated() {
        assert!(valid_marker(M));
        assert!(valid_marker(&new_nonce()));
        assert!(!valid_marker(""));
        assert!(!valid_marker("0123456789ABCDEF0123456789ABCDEF"));
        assert!(!valid_marker("0123456789abcdef0123456789abcde\""));
    }

    #[test]
    fn mode_and_policy() {
        assert_eq!(parse_mode("report-only"), Mode::ReportOnly);
        assert_eq!(parse_mode("Enforce"), Mode::Enforce);
        assert_eq!(parse_mode(""), Mode::Off);
        let n = new_nonce();
        let p = policy(&n, Some("/csp"));
        assert!(p.contains(&format!("script-src 'self' 'nonce-{n}'")));
        assert!(p.contains("style-src-attr 'unsafe-inline'"));
        assert!(p.ends_with("; report-uri /csp"));
        assert_eq!(n.len(), 32);
        assert_ne!(n, new_nonce());
    }
}
