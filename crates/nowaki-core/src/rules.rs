//! Config-level routing rules: nowaki.config `basePath`, `trailingSlash`, `redirects`,
//! `rewrites` and `headers`, read from the normalized `dist/server/routing.json` (the CLI's
//! site-config.mjs normalizes and validates the config at build time).
//!
//! Pure data and string matching, the same compiler and matcher as the runtime's
//! `server/rules.mjs`; `tests/fixtures/rules-cases.json` drives both. Sources and destinations
//! use the route segment grammar (`/blog/[slug]`, `/docs/[...rest]`, `/og/[card].png`). Sources
//! compare against percent-decoded segments; captures are percent-encoded per segment when
//! substituted, so a capture never adds a `/` or `\` to a path, and an external destination's
//! host is always a config literal.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The routing part of nowaki.config, as written to `dist/server/routing.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[non_exhaustive]
pub struct RoutingConfig {
    /// `""` or a path like `/app` (no trailing slash).
    pub base_path: String,
    pub trailing_slash: TrailingSlash,
    pub redirects: Vec<RedirectRule>,
    pub rewrites: Vec<RewriteRule>,
    pub headers: Vec<HeaderRule>,
    pub i18n: Option<I18nConfig>,
}

/// The trailing-slash policy. `Never` / `Always` redirect GET and HEAD requests (308) to the
/// canonical URL; `Ignore` serves both.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrailingSlash {
    Never,
    Always,
    #[default]
    Ignore,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RedirectRule {
    pub source: String,
    /// A path (`/new/[slug]`) or an `http(s)://` URL.
    pub destination: String,
    #[serde(default = "default_status")]
    pub status: u16,
}

fn default_status() -> u16 {
    307
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RewriteRule {
    pub source: String,
    /// An internal path only.
    pub destination: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct HeaderRule {
    pub source: String,
    pub headers: Vec<Header>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Header {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct I18nConfig {
    pub locales: Vec<String>,
    pub default_locale: String,
    #[serde(default)]
    pub prefix_default_locale: bool,
    #[serde(default)]
    pub detect: bool,
}

/// What a request becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Send a redirect. `location` doesn't carry the request's query; the caller appends it.
    Redirect { status: u16, location: String },
    /// Route this internal path instead (basePath already removed).
    Rewrite(String),
    /// Route the request path with basePath removed.
    Pass(String),
    /// Outside basePath.
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Seg {
    Lit(String),
    Param(String),
    Suffix(String, String),
    Rest(String),
}

impl Seg {
    fn param(&self) -> Option<&str> {
        match self {
            Seg::Lit(_) => None,
            Seg::Param(p) | Seg::Suffix(p, _) | Seg::Rest(p) => Some(p),
        }
    }
}

#[derive(Debug, Clone)]
struct Destination {
    /// `https://host` for an external destination, else empty.
    origin: String,
    segs: Vec<Seg>,
    /// `?query` / `#fragment` as written (redirects only).
    tail: String,
    /// The path part is empty (`https://host`, `https://host?x`).
    bare: bool,
    /// The path part ends with `/` (kept under `trailingSlash: "ignore"` and for external URLs).
    slash: bool,
}

#[derive(Debug, Clone)]
struct Rule<T> {
    index: usize,
    segs: Vec<Seg>,
    target: T,
}

#[derive(Debug, Clone)]
struct RuleSet<T> {
    rules: Vec<Rule<T>>,
    /// All-literal sources: decoded segments joined by `/` → first rule index.
    literals: HashMap<String, usize>,
    /// Indexes into `rules` of the other sources, in order.
    patterns: Vec<usize>,
}

#[derive(Debug, Clone)]
struct Redirect {
    status: u16,
    dest: Destination,
}

/// A header rule's source and its `(lowercase name, value)` pairs.
type HeaderSet = (Vec<Seg>, Vec<(String, String)>);

/// Compiled rules. Build with [`Rules::compile`]; [`Rules::is_empty`] means a front can skip
/// them entirely.
#[derive(Debug, Clone)]
pub struct Rules {
    base: String,
    trailing: TrailingSlash,
    redirects: RuleSet<Redirect>,
    rewrites: RuleSet<Destination>,
    headers: Vec<HeaderSet>,
}

impl Rules {
    /// Compiles and validates a routing config.
    pub fn compile(config: &RoutingConfig) -> Result<Rules, String> {
        let base = config.base_path.clone();
        check_base_path(&base)?;
        let redirects = compile_set(&config.redirects, "redirects", |r, segs| {
            if ![301, 302, 303, 307, 308].contains(&r.status) {
                return Err(format!(
                    "redirect status must be 301, 302, 303, 307 or 308 (got {})",
                    r.status
                ));
            }
            Ok(Redirect {
                status: r.status,
                dest: compile_destination(&r.destination, segs, true)?,
            })
        })?;
        let rewrites = compile_set(&config.rewrites, "rewrites", |r, segs| {
            compile_destination(&r.destination, segs, false)
        })?;
        let mut headers = Vec::new();
        for h in &config.headers {
            let segs = compile_source(&h.source, "headers")?;
            let mut pairs = Vec::new();
            for Header { key, value } in &h.headers {
                if key.is_empty() || !key.bytes().all(is_token) {
                    return Err(format!("invalid header name {key:?}"));
                }
                if value.contains(['\r', '\n', '\0']) {
                    return Err(format!(
                        "header {key}: the value must be a string without CR, LF or NUL"
                    ));
                }
                pairs.push((key.to_ascii_lowercase(), value.clone()));
            }
            headers.push((segs, pairs));
        }
        Ok(Rules {
            base,
            trailing: config.trailing_slash,
            redirects,
            rewrites,
            headers,
        })
    }

    /// Nothing to check per request: no basePath, `trailingSlash: "ignore"`, no rules.
    pub fn is_empty(&self) -> bool {
        self.base.is_empty()
            && self.trailing == TrailingSlash::Ignore
            && self.redirects.rules.is_empty()
            && self.rewrites.rules.is_empty()
            && self.headers.is_empty()
    }

    pub fn base_path(&self) -> &str {
        &self.base
    }

    pub fn trailing_slash(&self) -> TrailingSlash {
        self.trailing
    }

    /// The URL a browser uses for a route path: basePath in front and the trailing-slash policy
    /// (`Ignore` keeps the destination's `slash` flag).
    pub fn browser_path(&self, path: &str, slash: bool) -> String {
        format_browser_path(self, path, slash)
    }

    /// Applies basePath, the trailing-slash policy, then the first matching redirect, then the
    /// first matching rewrite. `path` is the raw (percent-encoded) request path.
    pub fn apply(&self, method: &str, path: &str) -> Outcome {
        if self.is_empty() {
            return Outcome::Pass(path.to_string());
        }
        let Some((p, bare)) = self.strip_base(path) else {
            return Outcome::NotFound;
        };
        let Some(decoded) = decode_parts(p) else {
            return Outcome::Pass(p.to_string());
        };
        // Only GET / HEAD are moved to the canonical URL; a POST to /form/ keeps working.
        if self.trailing != TrailingSlash::Ignore && (method == "GET" || method == "HEAD") {
            let dotted = decoded.last().is_some_and(|l| l.contains('.'));
            let mv = match self.trailing {
                TrailingSlash::Never if !self.base.is_empty() => !bare && p.ends_with('/'),
                TrailingSlash::Never => p.len() > 1 && p.ends_with('/'),
                _ if !self.base.is_empty() && bare => true,
                _ => !decoded.is_empty() && !dotted && !p.ends_with('/'),
            };
            if mv {
                let canonical = if decoded.is_empty() {
                    "/".to_string()
                } else {
                    let enc: Vec<String> = decoded.iter().map(|s| encode_segment(s)).collect();
                    format!("/{}", enc.join("/"))
                };
                return guard(Outcome::Redirect {
                    status: 308,
                    location: format_browser_path(self, &canonical, false),
                });
            }
        }
        if let Some((rule, params)) = find_rule(&self.redirects, &decoded) {
            let dest = &rule.target.dest;
            let path = substitute(&dest.segs, &params);
            let location = if dest.origin.is_empty() {
                format!(
                    "{}{}",
                    format_browser_path(self, &path, dest.slash),
                    dest.tail
                )
            } else if dest.bare {
                format!("{}{}", dest.origin, dest.tail)
            } else {
                let slash = if dest.slash { "/" } else { "" };
                format!("{}{path}{slash}{}", dest.origin, dest.tail)
            };
            return guard(Outcome::Redirect {
                status: rule.target.status,
                location,
            });
        }
        if let Some((rule, params)) = find_rule(&self.rewrites, &decoded) {
            return guard(Outcome::Rewrite(substitute(&rule.target.segs, &params)));
        }
        Outcome::Pass(p.to_string())
    }

    /// The config headers for a request path, in rule order; a later rule wins for the same
    /// name (in the first one's position).
    pub fn headers(&self, path: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        if self.headers.is_empty() {
            return out;
        }
        let Some(decoded) = self.strip_base(path).and_then(|(p, _)| decode_parts(p)) else {
            return out;
        };
        for (segs, pairs) in &self.headers {
            if match_segments(segs, &decoded).is_none() {
                continue;
            }
            for (k, v) in pairs {
                match out.iter_mut().find(|(name, _)| name == k) {
                    Some(e) => e.1 = v.clone(),
                    None => out.push((k.clone(), v.clone())),
                }
            }
        }
        out
    }

    /// `(path without basePath, whether the path was basePath itself)`.
    fn strip_base<'a>(&self, path: &'a str) -> Option<(&'a str, bool)> {
        if self.base.is_empty() {
            return Some((path, false));
        }
        if path == self.base {
            return Some(("/", true));
        }
        let rest = path.strip_prefix(self.base.as_str())?;
        rest.starts_with('/').then_some((rest, false))
    }
}

/// A route path as the browser sees it: basePath in front, the trailing-slash policy applied
/// (`Ignore` keeps what the destination wrote: `slash`).
fn format_browser_path(rules: &Rules, path: &str, slash: bool) -> String {
    let root = path == "/";
    let mut out = if root {
        if rules.base.is_empty() {
            "/".to_string()
        } else {
            rules.base.clone()
        }
    } else {
        format!("{}{path}", rules.base)
    };
    let last = if root {
        ""
    } else {
        &path[path.rfind('/').map_or(0, |i| i + 1)..]
    };
    let add = match rules.trailing {
        TrailingSlash::Always => !last.contains('.'),
        TrailingSlash::Ignore => slash,
        TrailingSlash::Never => false,
    };
    if add && !out.ends_with('/') {
        out.push('/');
    }
    out
}

/// `encodeURIComponent`, with `.` and `..` escaped so a capture can't step up a directory.
pub fn encode_segment(s: &str) -> String {
    match s {
        "." => return "%2E".to_string(),
        ".." => return "%2E%2E".to_string(),
        _ => {}
    }
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`: `None` for a malformed escape or bytes that aren't UTF-8.
pub fn decode_segment(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_string());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One segment of the route grammar, as the runtime's `parseSegment` reads it.
fn parse_segment(seg: &str) -> Seg {
    if let Some(inner) = seg
        .strip_prefix("[...")
        .and_then(|s| s.strip_suffix(']'))
        .filter(|s| !s.is_empty())
    {
        return Seg::Rest(inner.to_string());
    }
    if let Some(body) = seg.strip_prefix('[') {
        if let Some(close) = body.find(']') {
            let (name, ext) = (&body[..close], &body[close + 1..]);
            if !name.is_empty()
                && !name.contains('.')
                && ext.len() > 1
                && ext.starts_with('.')
                && !ext.contains('/')
            {
                return Seg::Suffix(name.to_string(), ext.to_string());
            }
        }
        if let Some(inner) = body.strip_suffix(']').filter(|s| !s.is_empty()) {
            return Seg::Param(inner.to_string());
        }
    }
    Seg::Lit(seg.to_string())
}

fn decode_parts(p: &str) -> Option<Vec<String>> {
    p.split('/')
        .filter(|s| !s.is_empty())
        .map(decode_segment)
        .collect()
}

#[derive(Debug, Clone)]
enum Capture {
    One(String),
    Many(Vec<String>),
}

fn match_segments(segs: &[Seg], parts: &[String]) -> Option<HashMap<String, Capture>> {
    let rest = matches!(segs.last(), Some(Seg::Rest(_)));
    if rest {
        if parts.len() < segs.len() {
            return None;
        }
    } else if segs.len() != parts.len() {
        return None;
    }
    let mut params = HashMap::new();
    let fixed = if rest { segs.len() - 1 } else { segs.len() };
    for (seg, part) in segs[..fixed].iter().zip(parts) {
        match seg {
            Seg::Lit(l) => {
                if l != part {
                    return None;
                }
            }
            Seg::Suffix(name, ext) => {
                if part.len() <= ext.len() || !part.ends_with(ext.as_str()) {
                    return None;
                }
                let value = part[..part.len() - ext.len()].to_string();
                params.insert(name.clone(), Capture::One(value));
            }
            Seg::Param(name) => {
                params.insert(name.clone(), Capture::One(part.clone()));
            }
            Seg::Rest(_) => return None,
        }
    }
    if let Some(Seg::Rest(name)) = segs.last() {
        params.insert(name.clone(), Capture::Many(parts[fixed..].to_vec()));
    }
    Some(params)
}

/// First matching rule in config order: a literal source by one map lookup, patterns in order.
fn find_rule<'a, T>(
    set: &'a RuleSet<T>,
    decoded: &[String],
) -> Option<(&'a Rule<T>, HashMap<String, Capture>)> {
    if set.rules.is_empty() {
        return None;
    }
    // A literal segment never holds "/", so a decoded %2F can't match one.
    let best = if !set.literals.is_empty() && !decoded.iter().any(|p| p.contains('/')) {
        set.literals.get(&decoded.join("/")).copied()
    } else {
        None
    };
    for &i in &set.patterns {
        let rule = &set.rules[i];
        if best.is_some_and(|b| rule.index > b) {
            break;
        }
        if let Some(params) = match_segments(&rule.segs, decoded) {
            return Some((rule, params));
        }
    }
    best.map(|b| (&set.rules[b], HashMap::new()))
}

fn substitute(segs: &[Seg], params: &HashMap<String, Capture>) -> String {
    if segs.is_empty() {
        return "/".to_string();
    }
    let mut out: Vec<String> = Vec::new();
    for seg in segs {
        match (seg, seg.param().and_then(|p| params.get(p))) {
            (Seg::Lit(l), _) => out.push(l.clone()),
            (Seg::Rest(_), Some(Capture::Many(v))) => {
                out.extend(v.iter().map(|s| encode_segment(s)))
            }
            (Seg::Param(_), Some(Capture::One(v))) => out.push(encode_segment(v)),
            (Seg::Suffix(_, ext), Some(Capture::One(v))) => {
                out.push(format!("{}{ext}", encode_segment(v)))
            }
            // compile() checks every destination param against the source.
            _ => {}
        }
    }
    format!("/{}", out.join("/"))
}

/// An internal location starts with exactly one `/` (`//x` and `/\x` leave the site).
fn guard(outcome: Outcome) -> Outcome {
    let loc = match &outcome {
        Outcome::Redirect { location, .. } => {
            if location.starts_with("http://") || location.starts_with("https://") {
                return outcome;
            }
            location
        }
        Outcome::Rewrite(path) => path,
        _ => return outcome,
    };
    let b = loc.as_bytes();
    if b.first() != Some(&b'/') || matches!(b.get(1), Some(b'/' | b'\\')) {
        return Outcome::NotFound;
    }
    outcome
}

fn is_token(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn is_control(c: char) -> bool {
    c < ' ' || c == '\u{7f}'
}

fn check_base_path(base: &str) -> Result<(), String> {
    if base.is_empty() {
        return Ok(());
    }
    let ok = base.starts_with('/')
        && !base.ends_with('/')
        && base[1..].split('/').all(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&b))
        });
    if !ok {
        return Err(format!("invalid basePath {base:?}"));
    }
    if base == "/__nowaki" || base.starts_with("/__nowaki/") {
        return Err("basePath can't be under /__nowaki/, which is reserved".to_string());
    }
    Ok(())
}

fn parse_path(path: &str, label: &str) -> Result<Vec<Seg>, String> {
    path.split('/')
        .map(|s| {
            if s.is_empty() {
                Err(format!("{label} has an empty segment"))
            } else {
                Ok(parse_segment(s))
            }
        })
        .collect()
}

fn compile_source(source: &str, kind: &str) -> Result<Vec<Seg>, String> {
    if !source.starts_with('/') {
        return Err(format!(
            "{kind}: source must start with \"/\" (got {source:?})"
        ));
    }
    if source
        .chars()
        .any(|c| is_control(c) || c == '?' || c == '#')
    {
        return Err(format!(
            "{kind}: source {source:?} must be a path without a query, fragment or control characters"
        ));
    }
    let segs = if source == "/" {
        Vec::new()
    } else {
        parse_path(&source[1..], &format!("{kind}: source {source:?}"))?
    };
    let mut names: Vec<&str> = Vec::new();
    for (i, s) in segs.iter().enumerate() {
        if let Seg::Rest(p) = s {
            if i != segs.len() - 1 {
                return Err(format!(
                    "{kind}: source {source:?}: [...{p}] must be the last segment"
                ));
            }
        }
        if let Some(p) = s.param() {
            if names.contains(&p) {
                return Err(format!("{kind}: source {source:?} repeats [{p}]"));
            }
            names.push(p);
        }
    }
    if matches!(segs.first(), Some(Seg::Lit(l)) if l == "__nowaki") {
        return Err(format!(
            "{kind}: source {source:?} is under /__nowaki/, which is reserved"
        ));
    }
    Ok(segs)
}

fn compile_destination(
    destination: &str,
    source: &[Seg],
    external: bool,
) -> Result<Destination, String> {
    let label = format!("destination {destination:?}");
    if !destination
        .bytes()
        .all(|b| (0x21..=0x7e).contains(&b) && b != b'\\')
    {
        return Err(format!(
            "{label} must be printable ASCII without spaces or backslashes (percent-encode the rest)"
        ));
    }
    let scheme = ["https://", "http://"]
        .into_iter()
        .find(|s| destination.starts_with(s));
    let (origin, rest) = if let Some(scheme) = scheme {
        if !external {
            return Err(format!(
                "rewrites: {label} must be a path starting with \"/\" (rewrites are internal)"
            ));
        }
        let after = &destination[scheme.len()..];
        let host_len = after.find(['/', '?', '#']).unwrap_or(after.len());
        let host = &after[..host_len];
        if host.is_empty() || host.contains(['[', ']']) {
            return Err(format!("{label} needs a literal host"));
        }
        let origin_len = scheme.len() + host_len;
        (&destination[..origin_len], &destination[origin_len..])
    } else {
        if !destination.starts_with('/') || destination[1..].starts_with('/') {
            return Err(format!("{label} must start with \"/\" or http(s)://"));
        }
        ("", destination)
    };
    let cut = rest.find(['?', '#']).unwrap_or(rest.len());
    let (path_part, tail) = rest.split_at(cut);
    if !tail.is_empty() && !external {
        return Err(format!("rewrites: {label} can't have a query or fragment"));
    }
    if tail.contains(['[', ']']) {
        return Err(format!("{label}: [params] can only be used in the path"));
    }
    let trimmed = path_part.strip_prefix('/').unwrap_or(path_part);
    let trimmed = trimmed.strip_suffix('/').unwrap_or(trimmed);
    let segs = if trimmed.is_empty() {
        Vec::new()
    } else {
        parse_path(trimmed, &label)?
    };
    if origin.is_empty() && matches!(segs.first(), Some(Seg::Lit(l)) if l == "__nowaki") {
        return Err(format!("{label} is under /__nowaki/, which is reserved"));
    }
    for s in &segs {
        let Some(p) = s.param() else { continue };
        let Some(from) = source.iter().find(|x| x.param() == Some(p)) else {
            return Err(format!("{label} uses [{p}], which the source doesn't have"));
        };
        if matches!(from, Seg::Rest(_)) != matches!(s, Seg::Rest(_)) {
            let dots = if matches!(s, Seg::Rest(_)) { "..." } else { "" };
            return Err(format!(
                "{label}: [{dots}{p}] must be used as written in the source"
            ));
        }
    }
    Ok(Destination {
        origin: origin.to_string(),
        segs,
        tail: tail.to_string(),
        bare: path_part.is_empty(),
        slash: path_part.len() > 1 && path_part.ends_with('/'),
    })
}

fn compile_set<R, T>(
    list: &[R],
    kind: &str,
    target: impl Fn(&R, &[Seg]) -> Result<T, String>,
) -> Result<RuleSet<T>, String>
where
    R: HasSource,
{
    let mut set = RuleSet {
        rules: Vec::new(),
        literals: HashMap::new(),
        patterns: Vec::new(),
    };
    for (index, r) in list.iter().enumerate() {
        let segs = compile_source(r.source(), kind)?;
        let t = target(r, &segs)?;
        let literal_segs: Option<Vec<&str>> = segs
            .iter()
            .map(|s| match s {
                Seg::Lit(l) => Some(l.as_str()),
                _ => None,
            })
            .collect();
        match literal_segs {
            Some(literal_segs) => {
                set.literals.entry(literal_segs.join("/")).or_insert(index);
            }
            None => set.patterns.push(index),
        }
        set.rules.push(Rule {
            index,
            segs,
            target: t,
        });
    }
    Ok(set)
}

trait HasSource {
    fn source(&self) -> &str;
}

impl HasSource for RedirectRule {
    fn source(&self) -> &str {
        &self.source
    }
}

impl HasSource for RewriteRule {
    fn source(&self) -> &str {
        &self.source
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(json: &str) -> Rules {
        Rules::compile(&serde_json::from_str(json).unwrap()).unwrap()
    }

    #[test]
    fn segment_grammar_matches_the_runtime() {
        assert_eq!(parse_segment("[...rest]"), Seg::Rest("rest".into()));
        assert_eq!(
            parse_segment("[card].png"),
            Seg::Suffix("card".into(), ".png".into())
        );
        assert_eq!(parse_segment("[id]"), Seg::Param("id".into()));
        assert_eq!(parse_segment("[...x].png"), Seg::Lit("[...x].png".into()));
        assert_eq!(parse_segment("[]"), Seg::Lit("[]".into()));
        assert_eq!(parse_segment("[a.b]"), Seg::Param("a.b".into()));
        assert_eq!(parse_segment("about"), Seg::Lit("about".into()));
    }

    #[test]
    fn percent_coding_matches_js() {
        assert_eq!(decode_segment("caf%C3%A9").as_deref(), Some("caf\u{e9}"));
        assert_eq!(decode_segment("50%"), None);
        assert_eq!(decode_segment("%E0%A4"), None);
        assert_eq!(decode_segment("%zz"), None);
        assert_eq!(encode_segment("a b/c\\"), "a%20b%2Fc%5C");
        assert_eq!(encode_segment("caf\u{e9}"), "caf%C3%A9");
        assert_eq!(encode_segment("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_segment(".."), "%2E%2E");
    }

    #[test]
    fn empty_config_is_a_fast_pass() {
        let r = rules("{}");
        assert!(r.is_empty());
        assert_eq!(r.apply("GET", "/a/"), Outcome::Pass("/a/".into()));
        assert!(r.headers("/a").is_empty());
    }

    #[test]
    fn a_literal_after_a_pattern_keeps_config_order() {
        let r = rules(
            r#"{"redirects":[
                {"source":"/a/[x]","destination":"/p/[x]","status":307},
                {"source":"/a/b","destination":"/lit","status":307}
            ]}"#,
        );
        assert_eq!(
            r.apply("GET", "/a/b"),
            Outcome::Redirect {
                status: 307,
                location: "/p/b".into()
            }
        );
    }

    #[test]
    fn browser_path_applies_base_path_and_trailing_policy() {
        let r = rules(r#"{"basePath":"/app","trailingSlash":"always"}"#);
        assert_eq!(r.browser_path("/about", false), "/app/about/");
        assert_eq!(r.browser_path("/feed.xml", false), "/app/feed.xml");
        let r = rules(r#"{"trailingSlash":"never"}"#);
        assert_eq!(r.browser_path("/about", false), "/about");
    }
}
