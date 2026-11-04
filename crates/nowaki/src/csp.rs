//! Opt-in Content Security Policy with a per-response nonce (`NOWAKI_CSP=report-only|enforce`).
//!
//! Every `<script>` / `<style>` in an HTML response gets `nonce="…"`, injected while the body
//! streams, so streaming SSR stays streaming. The layer wraps the ISR cache too: cached HTML is
//! stored without a nonce and each response (HIT included) gets a fresh one. A response that
//! already sets its own CSP is left alone. Mirrors `packages/nowaki-runtime/server/csp.mjs`.

use std::sync::OnceLock;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use futures_util::StreamExt;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Off,
    ReportOnly,
    Enforce,
}

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

const TAGS: [&[u8]; 2] = [b"script", b"style"];

/// Inserts ` nonce="…"` after `<script` / `<style` (any case) across chunk boundaries.
pub struct Injector {
    attr: Vec<u8>,
    carry: Vec<u8>,
}

impl Injector {
    pub fn new(nonce: &str) -> Self {
        Self {
            attr: format!(" nonce=\"{nonce}\"").into_bytes(),
            carry: Vec::new(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        let mut out = Vec::with_capacity(data.len() + 64);
        let mut i = 0;
        while i < data.len() {
            if data[i] != b'<' {
                out.push(data[i]);
                i += 1;
                continue;
            }
            match tag_at(&data[i..]) {
                Match::Tag(len) => {
                    out.extend_from_slice(&data[i..i + 1 + len]);
                    out.extend_from_slice(&self.attr);
                    i += 1 + len;
                }
                Match::Partial => {
                    // Could still become `<script` with the next chunk.
                    self.carry = data[i..].to_vec();
                    return out;
                }
                Match::No => {
                    out.push(b'<');
                    i += 1;
                }
            }
        }
        out
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.carry)
    }
}

enum Match {
    Tag(usize),
    Partial,
    No,
}

/// `s` starts with `<`. Tag(name length) when it opens a script/style element.
fn tag_at(s: &[u8]) -> Match {
    let rest = &s[1..];
    for tag in TAGS {
        let n = tag.len().min(rest.len());
        if !rest[..n].eq_ignore_ascii_case(&tag[..n]) {
            continue;
        }
        if rest.len() <= tag.len() {
            return Match::Partial;
        }
        let next = rest[tag.len()];
        if next.is_ascii_whitespace() || next == b'>' || next == b'/' {
            return Match::Tag(tag.len());
        }
    }
    Match::No
}

/// `axum::middleware::from_fn` layer for dev and start.
pub async fn layer(req: Request, next: Next) -> Response {
    let mode = mode();
    let resp = next.run(req).await;
    if mode == Mode::Off {
        return resp;
    }
    let is_html = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/html"));
    let has_csp = resp.headers().contains_key(header::CONTENT_SECURITY_POLICY)
        || resp
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY_REPORT_ONLY);
    if !is_html || has_csp {
        return resp;
    }
    let nonce = new_nonce();
    let (mut parts, body) = resp.into_parts();
    let name: HeaderName = match mode {
        Mode::Enforce => header::CONTENT_SECURITY_POLICY,
        _ => header::CONTENT_SECURITY_POLICY_REPORT_ONLY,
    };
    if let Ok(v) = HeaderValue::from_str(&policy(&nonce, report_uri())) {
        parts.headers.insert(name, v);
    }
    parts.headers.remove(header::CONTENT_LENGTH);
    let mut inj = Injector::new(&nonce);
    let mut done = false;
    let stream = body
        .into_data_stream()
        .map(Some)
        .chain(futures_util::stream::once(async { None }));
    let mapped = stream.filter_map(move |item| {
        let out = match item {
            Some(Ok(chunk)) => Some(Ok::<Bytes, axum::Error>(Bytes::from(inj.push(&chunk)))),
            Some(Err(e)) => Some(Err(e)),
            None if !done => {
                done = true;
                Some(Ok(Bytes::from(inj.finish())))
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

    /// Runs the injector with a fresh nonce; expectations use `{n}` for it.
    fn inject(chunks: &[&str], expected: &str) {
        let n = new_nonce();
        let mut inj = Injector::new(&n);
        let mut out = Vec::new();
        for c in chunks {
            out.extend(inj.push(c.as_bytes()));
        }
        out.extend(inj.finish());
        assert_eq!(String::from_utf8(out).unwrap(), expected.replace("{n}", &n));
    }

    #[test]
    fn adds_nonce_to_script_and_style_tags() {
        inject(
            &[
                r#"<head><style>a{}</style><script type="module" src="/x.js"></script><SCRIPT>1</SCRIPT></head>"#,
            ],
            r#"<head><style nonce="{n}">a{}</style><script nonce="{n}" type="module" src="/x.js"></script><SCRIPT nonce="{n}">1</SCRIPT></head>"#,
        );
    }

    #[test]
    fn leaves_other_tags_alone() {
        let html = "<scripts></scripts><styled-x></styled-x><p>&lt;script&gt;</p><s>x</s>";
        inject(&[html], html);
    }

    #[test]
    fn works_across_chunk_boundaries() {
        inject(
            &["<p>a</p><scr", "ipt>1</script><sty", "le", ">b</style>"],
            r#"<p>a</p><script nonce="{n}">1</script><style nonce="{n}">b</style>"#,
        );
        inject(&["end <", "scrap"], "end <scrap");
        inject(&["tail <scri"], "tail <scri");
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
