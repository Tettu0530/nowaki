//! Observability for the Rust front: Server-Timing (`NOWAKI_SERVER_TIMING=1`), JSON log lines
//! (`NOWAKI_LOG=json`), and an OTLP/HTTP JSON trace exporter configured by the standard `OTEL_*`
//! variables. All of it is read once into [`get`]'s `OnceLock`; with nothing on, a request pays
//! [`Obs::active`]. The sidecar's half is `server/trace.mjs` / `otel.mjs` / `log.mjs`, which read the
//! same variables (the child process inherits them) and encode the same OTLP shape
//! (`tests/fixtures/otel-cases.json`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};

/// The observability settings of this process, read once by [`get`].
pub struct Obs {
    /// `server-timing` on `nowaki start` responses (dev's sidecar sends its own).
    pub timing: bool,
    /// One JSON object per log line, plus an access log line per request.
    pub json: bool,
    otel: Option<Otel>,
}

impl Obs {
    /// Whether any of Server-Timing, JSON logs or tracing is on.
    pub fn active(&self) -> bool {
        self.timing || self.json || self.otel.is_some()
    }

    /// The trace exporter, when tracing is on.
    pub fn otel(&self) -> Option<&Otel> {
        self.otel.as_ref()
    }
}

static OBS: OnceLock<Obs> = OnceLock::new();

/// The settings, read on first use. The OTLP exporter task starts then, so the first call must be
/// on the tokio runtime (`start::run` makes it before serving).
pub fn get() -> &'static Obs {
    OBS.get_or_init(|| {
        let var = |k: &str| std::env::var(k).ok();
        let json = var("NOWAKI_LOG").is_some_and(|v| v.trim().eq_ignore_ascii_case("json"));
        let timing = var("NOWAKI_SERVER_TIMING").is_some_and(|v| truthy(&v));
        let otel = match otel_config(var) {
            Ok(Some(cfg)) => Otel::spawn(cfg),
            Ok(None) => None,
            Err(why) => {
                log_with(json, "warn", &why, &[]);
                None
            }
        };
        Obs { timing, json, otel }
    })
}

fn truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

// ---- W3C trace context ----

/// A parsed W3C `traceparent` header.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TraceParent {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub sampled: bool,
}

fn hex_into(s: &str, out: &mut [u8]) -> Option<()> {
    if s.len() != out.len() * 2 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(())
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// `00-<trace>-<span>-<flags>`; later versions may append fields. All-zero ids are invalid.
pub fn parse_traceparent(value: &str) -> Option<TraceParent> {
    let parts: Vec<&str> = value.trim().split('-').collect();
    if parts.len() < 4 {
        return None;
    }
    let version = parts[0];
    if version.len() != 2
        || version == "ff"
        || !version
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        || (version == "00" && parts.len() != 4)
    {
        return None;
    }
    let lower = |s: &str| s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !lower(parts[1]) || !lower(parts[2]) || !lower(parts[3]) {
        return None;
    }
    let mut trace_id = [0u8; 16];
    let mut span_id = [0u8; 8];
    let mut flags = [0u8; 1];
    hex_into(parts[1], &mut trace_id)?;
    hex_into(parts[2], &mut span_id)?;
    hex_into(parts[3], &mut flags)?;
    if trace_id == [0; 16] || span_id == [0; 8] {
        return None;
    }
    Some(TraceParent {
        trace_id,
        span_id,
        sampled: flags[0] & 1 == 1,
    })
}

pub fn format_traceparent(trace_id: &[u8; 16], span_id: &[u8; 8], sampled: bool) -> String {
    format!(
        "00-{}-{}-{}",
        hex(trace_id),
        hex(span_id),
        if sampled { "01" } else { "00" }
    )
}

// ---- sampling ----

/// The sampling rule from `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sampler {
    /// A parent's sampled flag decides when there is one.
    pub parent: bool,
    /// The share of root traces sampled: 1 = always, 0 = never.
    pub ratio: f64,
}

impl Sampler {
    /// `OTEL_TRACES_SAMPLER` / `_ARG`; unknown names are parentbased_always_on (the default).
    pub fn parse(name: Option<&str>, arg: Option<&str>) -> Sampler {
        let ratio = arg
            .and_then(|a| a.trim().parse::<f64>().ok())
            .filter(|r| (0.0..=1.0).contains(r))
            .unwrap_or(1.0);
        let name = name
            .map(|n| n.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let (parent, ratio) = match name.as_str() {
            "always_on" => (false, 1.0),
            "always_off" => (false, 0.0),
            "traceidratio" => (false, ratio),
            "parentbased_always_off" => (true, 0.0),
            "parentbased_traceidratio" => (true, ratio),
            _ => (true, 1.0),
        };
        Sampler { parent, ratio }
    }

    /// The trace id's low 64 bits against the ratio (otel.mjs `sample` uses the same rule).
    pub fn sample(&self, trace_id: &[u8; 16], parent_sampled: Option<bool>) -> bool {
        if let (true, Some(p)) = (self.parent, parent_sampled) {
            return p;
        }
        if self.ratio >= 1.0 {
            return true;
        }
        if self.ratio <= 0.0 {
            return false;
        }
        let low = u64::from_be_bytes(trace_id[8..].try_into().expect("8 bytes")) >> 11;
        (low as f64) / ((1u64 << 53) as f64) < self.ratio
    }
}

// ---- configuration ----

/// The OTLP exporter settings read from the `OTEL_*` variables.
#[derive(Debug, PartialEq)]
pub struct OtelConfig {
    pub endpoint: String,
    pub headers: Vec<(String, String)>,
    pub service: String,
    pub sampler: Sampler,
    pub delay: Duration,
    pub max_batch: usize,
    pub max_queue: usize,
}

/// `Ok(None)`: tracing is off (no endpoint, or `OTEL_SDK_DISABLED=true`). `Err`: it was asked for
/// but can't run here (an endpoint that isn't `http://`: this binary speaks plain HTTP to the
/// collector).
pub fn otel_config(var: impl Fn(&str) -> Option<String>) -> Result<Option<OtelConfig>, String> {
    if var("OTEL_SDK_DISABLED").is_some_and(|v| truthy(&v)) {
        return Ok(None);
    }
    let traces = var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").map(|s| s.trim().to_string());
    let base = var("OTEL_EXPORTER_OTLP_ENDPOINT").map(|s| s.trim().to_string());
    let endpoint = match (
        traces.filter(|s| !s.is_empty()),
        base.filter(|s| !s.is_empty()),
    ) {
        (Some(t), _) => t,
        (None, Some(b)) => format!("{}/v1/traces", b.trim_end_matches('/')),
        (None, None) => return Ok(None),
    };
    if endpoint.len() >= 8 && endpoint[..8].eq_ignore_ascii_case("https://") {
        return Err(format!(
            "OTLP export from the Rust front needs a plain http:// endpoint (got {endpoint}); run a local collector and point OTEL_EXPORTER_OTLP_ENDPOINT at it. Rust spans are off; the sidecar still exports its own."
        ));
    }
    if !endpoint.starts_with("http://") {
        return Err(format!(
            "OTEL_EXPORTER_OTLP_ENDPOINT must be an http:// URL (got {endpoint}); Rust spans are off"
        ));
    }
    let num = |k: &str, d: u64| {
        var(k)
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(d)
    };
    Ok(Some(OtelConfig {
        endpoint,
        headers: parse_headers(
            var("OTEL_EXPORTER_OTLP_TRACES_HEADERS")
                .or_else(|| var("OTEL_EXPORTER_OTLP_HEADERS"))
                .as_deref()
                .unwrap_or(""),
        ),
        service: var("OTEL_SERVICE_NAME")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "nowaki".to_string()),
        sampler: Sampler::parse(
            var("OTEL_TRACES_SAMPLER").as_deref(),
            var("OTEL_TRACES_SAMPLER_ARG").as_deref(),
        ),
        delay: Duration::from_millis(num("OTEL_BSP_SCHEDULE_DELAY", 5000)),
        max_batch: num("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512) as usize,
        max_queue: num("OTEL_BSP_MAX_QUEUE_SIZE", 2048) as usize,
    }))
}

/// Parses `k1=v1,k2=v2` with values percent-decoded (`OTEL_EXPORTER_OTLP_TRACES_HEADERS`, else
/// `OTEL_EXPORTER_OTLP_HEADERS`).
pub fn parse_headers(raw: &str) -> Vec<(String, String)> {
    raw.split(',')
        .filter_map(|part| {
            let (k, v) = part.split_once('=')?;
            let k = k.trim();
            (!k.is_empty()).then(|| (k.to_string(), percent_decode(v.trim())))
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let (Some(h), Some(l)) = (
                b.get(i + 1).and_then(|c| (*c as char).to_digit(16)),
                b.get(i + 2).and_then(|c| (*c as char).to_digit(16)),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---- spans ----

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Server = 2,
    Client = 3,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Attr {
    Str(String),
    Int(i64),
}

/// A span of the Rust front, exported when it ends sampled.
#[derive(Clone, Debug)]
pub struct Span {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent: Option<[u8; 8]>,
    pub sampled: bool,
    pub name: String,
    pub kind: Kind,
    pub start: u64,
    pub end: u64,
    pub attrs: Vec<(&'static str, Attr)>,
    pub error: bool,
}

impl Span {
    /// The `traceparent` that makes a callee's span this one's child.
    pub fn traceparent(&self) -> String {
        format_traceparent(&self.trace_id, &self.span_id, self.sampled)
    }

    pub fn attr(&mut self, key: &'static str, value: Attr) {
        self.attrs.push((key, value));
    }
}

fn unix_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// One span in OTLP/JSON (ids in hex, times as decimal strings).
pub fn otlp_span(s: &Span) -> Value {
    let attrs: Vec<Value> = s
        .attrs
        .iter()
        .map(|(k, v)| {
            let value = match v {
                Attr::Str(s) => json!({ "stringValue": s }),
                Attr::Int(n) => json!({ "intValue": n.to_string() }),
            };
            json!({ "key": k, "value": value })
        })
        .collect();
    let mut out = Map::new();
    out.insert("traceId".into(), hex(&s.trace_id).into());
    out.insert("spanId".into(), hex(&s.span_id).into());
    out.insert("name".into(), s.name.clone().into());
    out.insert("kind".into(), (s.kind as u8).into());
    out.insert("startTimeUnixNano".into(), s.start.to_string().into());
    out.insert("endTimeUnixNano".into(), s.end.to_string().into());
    out.insert("attributes".into(), attrs.into());
    out.insert(
        "status".into(),
        if s.error {
            json!({ "code": 2 })
        } else {
            json!({})
        },
    );
    if let Some(p) = s.parent {
        out.insert("parentSpanId".into(), hex(&p).into());
    }
    Value::Object(out)
}

/// An OTLP/JSON export request body: one resource with one scope holding `spans`.
pub fn otlp_body(resource: &[(&str, String)], spans: &[Span]) -> Value {
    let attrs: Vec<Value> = resource
        .iter()
        .map(|(k, v)| json!({ "key": k, "value": { "stringValue": v } }))
        .collect();
    json!({
        "resourceSpans": [{
            "resource": { "attributes": attrs },
            "scopeSpans": [{
                "scope": { "name": "nowaki" },
                "spans": spans.iter().map(otlp_span).collect::<Vec<_>>(),
            }],
        }],
    })
}

enum Msg {
    Span(Box<Span>),
    Flush(oneshot::Sender<()>),
}

/// The trace exporter: creates spans and queues finished ones for the export task.
pub struct Otel {
    sampler: Sampler,
    tx: mpsc::Sender<Msg>,
    seed: u64,
    counter: AtomicU64,
}

impl Otel {
    fn spawn(cfg: OtelConfig) -> Option<Otel> {
        let rt = tokio::runtime::Handle::try_current().ok()?;
        let mut seed = [0u8; 8];
        getrandom::fill(&mut seed).ok()?;
        let seed = u64::from_le_bytes(seed);
        let (tx, rx) = mpsc::channel(cfg.max_queue);
        let sampler = cfg.sampler;
        rt.spawn(export_loop(cfg, rx, hex(&seed.to_le_bytes())));
        Some(Otel {
            sampler,
            tx,
            seed,
            counter: AtomicU64::new(0),
        })
    }

    fn next_id(&self) -> u128 {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        xxhash_rust::xxh3::xxh3_128_with_seed(&n.to_le_bytes(), self.seed)
    }

    fn span_id(&self) -> [u8; 8] {
        loop {
            let id = (self.next_id() as u64).to_be_bytes();
            if id != [0; 8] {
                return id;
            }
        }
    }

    /// A span with no local parent: under `parent` (an incoming `traceparent`) when given.
    pub fn root(&self, name: String, kind: Kind, parent: Option<TraceParent>) -> Span {
        let trace_id = match parent {
            Some(p) => p.trace_id,
            None => loop {
                let id = self.next_id().to_be_bytes();
                if id != [0; 16] {
                    break id;
                }
            },
        };
        Span {
            trace_id,
            span_id: self.span_id(),
            parent: parent.map(|p| p.span_id),
            sampled: self.sampler.sample(&trace_id, parent.map(|p| p.sampled)),
            name,
            kind,
            start: unix_nanos(),
            end: 0,
            attrs: Vec::new(),
            error: false,
        }
    }

    /// A span under a local `parent`, sharing its trace and sampling decision.
    pub fn child(&self, parent: &Span, name: String, kind: Kind) -> Span {
        Span {
            trace_id: parent.trace_id,
            span_id: self.span_id(),
            parent: Some(parent.span_id),
            sampled: parent.sampled,
            name,
            kind,
            start: unix_nanos(),
            end: 0,
            attrs: Vec::new(),
            error: false,
        }
    }

    /// Queues a finished span; a full queue drops it (a request never waits on the exporter).
    pub fn end(&self, mut span: Span) {
        if !span.sampled {
            return;
        }
        span.end = unix_nanos();
        let _ = self.tx.try_send(Msg::Span(Box::new(span)));
    }
}

/// Sends what is queued (on shutdown), waiting at most `limit`.
pub async fn flush(limit: Duration) {
    let Some(otel) = OBS.get().and_then(|o| o.otel.as_ref()) else {
        return;
    };
    let (tx, rx) = oneshot::channel();
    if otel.tx.try_send(Msg::Flush(tx)).is_ok() {
        let _ = tokio::time::timeout(limit, rx).await;
    }
}

async fn export_loop(cfg: OtelConfig, mut rx: mpsc::Receiver<Msg>, instance: String) {
    let http = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let resource = [
        ("service.name", cfg.service.clone()),
        ("service.instance.id", instance),
        ("telemetry.sdk.name", "nowaki".to_string()),
        ("telemetry.sdk.language", "rust".to_string()),
    ];
    let mut buf: Vec<Span> = Vec::new();
    let mut deadline = None;
    let mut warned = false;
    loop {
        let msg = match deadline {
            Some(d) => match tokio::time::timeout_at(d, rx.recv()).await {
                Ok(m) => m,
                Err(_) => {
                    deadline = None;
                    send(&http, &cfg, &resource, &mut buf, &mut warned).await;
                    continue;
                }
            },
            None => rx.recv().await,
        };
        match msg {
            Some(Msg::Span(s)) => {
                buf.push(*s);
                if buf.len() >= cfg.max_batch {
                    deadline = None;
                    send(&http, &cfg, &resource, &mut buf, &mut warned).await;
                } else if deadline.is_none() {
                    deadline = Some(tokio::time::Instant::now() + cfg.delay);
                }
            }
            Some(Msg::Flush(done)) => {
                deadline = None;
                send(&http, &cfg, &resource, &mut buf, &mut warned).await;
                let _ = done.send(());
            }
            None => {
                send(&http, &cfg, &resource, &mut buf, &mut warned).await;
                return;
            }
        }
    }
}

async fn send(
    http: &reqwest::Client,
    cfg: &OtelConfig,
    resource: &[(&str, String)],
    buf: &mut Vec<Span>,
    warned: &mut bool,
) {
    if buf.is_empty() {
        return;
    }
    let body = otlp_body(resource, buf).to_string();
    buf.clear();
    let mut req = http
        .post(&cfg.endpoint)
        .header("content-type", "application/json")
        .body(body);
    for (k, v) in &cfg.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let failed = match req.send().await {
        Ok(r) if r.status().is_success() => None,
        Ok(r) => Some(format!("HTTP {}", r.status().as_u16())),
        Err(e) => Some(e.to_string()),
    };
    if let (Some(why), false) = (failed, *warned) {
        *warned = true;
        log(
            "warn",
            &format!(
                "OTLP export to {} failed ({why}); spans are dropped until it answers",
                cfg.endpoint
            ),
            &[],
        );
    }
}

// ---- Server-Timing ----

/// The front's entries after the sidecar's: `isr;desc=HIT|STALE|MISS` for ISR pages and `total`.
pub fn server_timing(prev: Option<&str>, isr: Option<&str>, total: Duration) -> String {
    let mut s = String::new();
    if let Some(p) = prev.filter(|p| !p.is_empty()) {
        s.push_str(p);
        s.push_str(", ");
    }
    if let Some(i) = isr {
        s.push_str("isr;desc=");
        s.push_str(i);
        s.push_str(", ");
    }
    s.push_str(&format!("total;dur={:.1}", total.as_secs_f64() * 1000.0));
    s
}

// ---- logs ----

/// A UTC RFC 3339 timestamp with milliseconds.
pub fn rfc3339(nanos: u64) -> String {
    let secs = nanos / 1_000_000_000;
    let ms = (nanos / 1_000_000) % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

/// One log line: `{ time, level, msg, source: "rust", ...fields }`. `fields` may override `source`.
pub fn log_line(time: u64, level: &str, msg: &str, fields: &[(&str, Value)]) -> String {
    let mut m = Map::new();
    m.insert("time".into(), rfc3339(time).into());
    m.insert("level".into(), level.into());
    m.insert("msg".into(), msg.into());
    m.insert("source".into(), "rust".into());
    for (k, v) in fields {
        m.insert((*k).to_string(), v.clone());
    }
    Value::Object(m).to_string()
}

fn log_with(json: bool, level: &str, msg: &str, fields: &[(&str, Value)]) {
    if json {
        println!("{}", log_line(unix_nanos(), level, msg, fields));
    } else {
        eprintln!("[nowaki] {msg}");
    }
}

/// A log message: a JSON line under `NOWAKI_LOG=json`, else `[nowaki] msg` on stderr.
pub fn log(level: &str, msg: &str, fields: &[(&str, Value)]) {
    log_with(get().json, level, msg, fields);
}

/// A line the sidecar printed: passed through when it is already a JSON object (log.mjs), else
/// wrapped as `{ source: "sidecar", msg }`; outside JSON mode, printed as `[sidecar] line`.
pub fn sidecar_line(line: &str) {
    if !get().json {
        println!("[sidecar] {line}");
        return;
    }
    if line.starts_with('{') && serde_json::from_str::<Map<String, Value>>(line).is_ok() {
        println!("{line}");
    } else {
        println!(
            "{}",
            log_line(unix_nanos(), "info", line, &[("source", "sidecar".into())])
        );
    }
}

/// The access log line of one request (JSON mode only).
pub fn access_log(
    method: &str,
    path: &str,
    status: u16,
    dur: Duration,
    isr: Option<&str>,
    span: Option<&Span>,
) {
    let mut fields: Vec<(&str, Value)> = vec![
        ("method", method.into()),
        ("path", path.into()),
        ("status", status.into()),
        ("dur_ms", ((dur.as_secs_f64() * 1e6).round() / 1e3).into()),
    ];
    if let Some(i) = isr {
        fields.push(("isr", i.into()));
    }
    if let Some(s) = span.filter(|s| s.sampled) {
        fields.push(("trace_id", hex(&s.trace_id).into()));
        fields.push(("span_id", hex(&s.span_id).into()));
    }
    println!("{}", log_line(unix_nanos(), "info", "request", &fields));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let text = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/otel-cases.json"),
        )
        .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn id<const N: usize>(s: &str) -> [u8; N] {
        let mut out = [0u8; N];
        hex_into(s, &mut out).unwrap();
        out
    }

    #[test]
    fn traceparent_cases_match_the_fixture() {
        for case in fixture()["traceparent"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let got = parse_traceparent(input);
            match case.get("traceId").and_then(|v| v.as_str()) {
                None => assert_eq!(got, None, "{input} must be rejected"),
                Some(t) => {
                    let got = got.unwrap_or_else(|| panic!("{input} must parse"));
                    assert_eq!(hex(&got.trace_id), t);
                    assert_eq!(hex(&got.span_id), case["spanId"].as_str().unwrap());
                    assert_eq!(got.sampled, case["sampled"].as_bool().unwrap());
                }
            }
        }
    }

    #[test]
    fn traceparent_round_trips() {
        let t = id::<16>("4bf92f3577b34da6a3ce929d0e0e4736");
        let s = id::<8>("00f067aa0ba902b7");
        let tp = format_traceparent(&t, &s, true);
        assert_eq!(
            tp,
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        assert_eq!(
            parse_traceparent(&tp),
            Some(TraceParent {
                trace_id: t,
                span_id: s,
                sampled: true
            })
        );
        assert!(format_traceparent(&t, &s, false).ends_with("-00"));
    }

    #[test]
    fn sampler_cases_match_the_fixture() {
        for case in fixture()["sampler"].as_array().unwrap() {
            let s = Sampler::parse(case["name"].as_str(), case["arg"].as_str());
            let parent = case["parentSampled"].as_bool();
            let trace = id::<16>(case["traceId"].as_str().unwrap());
            assert_eq!(
                s.sample(&trace, parent),
                case["sampled"].as_bool().unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn otlp_span_matches_the_fixture() {
        let f = fixture();
        let input = &f["span"]["input"];
        let span = Span {
            trace_id: id(input["traceId"].as_str().unwrap()),
            span_id: id(input["spanId"].as_str().unwrap()),
            parent: Some(id(input["parentSpanId"].as_str().unwrap())),
            sampled: true,
            name: input["name"].as_str().unwrap().to_string(),
            kind: Kind::Server,
            start: input["start"].as_str().unwrap().parse().unwrap(),
            end: input["end"].as_str().unwrap().parse().unwrap(),
            attrs: input["attrs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|kv| {
                    let k: &'static str = Box::leak(kv[0].as_str().unwrap().to_string().into());
                    let v = match &kv[1] {
                        Value::Number(n) => Attr::Int(n.as_i64().unwrap()),
                        v => Attr::Str(v.as_str().unwrap().to_string()),
                    };
                    (k, v)
                })
                .collect(),
            error: input["error"].as_bool().unwrap(),
        };
        assert_eq!(input["kind"].as_u64(), Some(Kind::Server as u64));
        assert_eq!(otlp_span(&span), f["span"]["otlp"]);
        let body = otlp_body(&[("service.name", "app".to_string())], &[span]);
        assert_eq!(
            body["resourceSpans"][0]["scopeSpans"][0]["spans"][0],
            f["span"]["otlp"]
        );
        assert_eq!(
            body["resourceSpans"][0]["resource"]["attributes"][0],
            json!({ "key": "service.name", "value": { "stringValue": "app" } })
        );
    }

    #[test]
    fn config_follows_the_otel_variables() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(otel_config(env(&[])), Ok(None));
        assert_eq!(
            otel_config(env(&[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"),
                ("OTEL_SDK_DISABLED", "true")
            ])),
            Ok(None)
        );
        let c = otel_config(env(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318/"),
            ("OTEL_EXPORTER_OTLP_HEADERS", "x-key=a%20b, x-team = web"),
            ("OTEL_SERVICE_NAME", "shop"),
            ("OTEL_TRACES_SAMPLER", "parentbased_traceidratio"),
            ("OTEL_TRACES_SAMPLER_ARG", "0.25"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(c.endpoint, "http://127.0.0.1:4318/v1/traces");
        assert_eq!(
            c.headers,
            vec![
                ("x-key".to_string(), "a b".to_string()),
                ("x-team".to_string(), "web".to_string())
            ]
        );
        assert_eq!(c.service, "shop");
        assert_eq!(
            c.sampler,
            Sampler {
                parent: true,
                ratio: 0.25
            }
        );
        // The traces endpoint is used as given.
        let c = otel_config(env(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://a:1"),
            ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://b:2/x"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(c.endpoint, "http://b:2/x");
        assert!(otel_config(env(&[(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "https://otlp.example"
        )]))
        .is_err());
    }

    #[test]
    fn log_lines_have_the_shared_shape() {
        let line = log_line(
            1_700_000_000_123_000_000,
            "info",
            "request",
            &[("status", 200.into()), ("trace_id", "ab".into())],
        );
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["time"], "2023-11-14T22:13:20.123Z");
        assert_eq!(v["level"], "info");
        assert_eq!(v["msg"], "request");
        assert_eq!(v["source"], "rust");
        assert_eq!(v["status"], 200);
        assert_eq!(v["trace_id"], "ab");
        assert!(!line.contains('\n'));
        let v: Value =
            serde_json::from_str(&log_line(0, "warn", "x", &[("source", "sidecar".into())]))
                .unwrap();
        assert_eq!(v["source"], "sidecar");
        assert_eq!(v["time"], "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(951_782_400_000_000_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn server_timing_appends_after_the_sidecar() {
        let ms = Duration::from_micros(2345);
        assert_eq!(server_timing(None, None, ms), "total;dur=2.3");
        assert_eq!(
            server_timing(Some("loader;dur=1.0, render;dur=0.5"), Some("MISS"), ms),
            "loader;dur=1.0, render;dur=0.5, isr;desc=MISS, total;dur=2.3"
        );
        assert_eq!(
            server_timing(None, Some("HIT"), ms),
            "isr;desc=HIT, total;dur=2.3"
        );
    }

    #[test]
    fn percent_decoding_keeps_malformed_escapes() {
        assert_eq!(percent_decode("a%20b%2"), "a b%2");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
