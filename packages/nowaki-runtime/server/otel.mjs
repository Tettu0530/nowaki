// A small OTLP/HTTP JSON trace exporter (no dependencies, no node: imports, so the worker uses it
// too). Configured by the standard OTEL_* variables; `otelConfig` returns null when they don't turn
// it on. The Rust side (crates/nowaki/src/obs.rs) reads the same variables and encodes the same shape.

const SCOPE = { name: "nowaki" };

export const SPAN_KIND = { internal: 1, server: 2, client: 3 };

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/// The exporter settings from `source` (process.env, or a Worker's bindings), or null when tracing
/// is off: no OTLP endpoint, or OTEL_SDK_DISABLED=true.
export function otelConfig(source = globalThis.process?.env ?? {}) {
  if (truthy(source.OTEL_SDK_DISABLED)) return null;
  const traces = String(source.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "").trim();
  const base = String(source.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  if (!traces && !base) return null;
  const endpoint = traces || `${base.replace(/\/+$/, "")}/v1/traces`;
  return {
    endpoint,
    headers: parseHeaders(source.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? source.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: String(source.OTEL_SERVICE_NAME ?? "").trim() || "nowaki",
    sampler: parseSampler(source.OTEL_TRACES_SAMPLER, source.OTEL_TRACES_SAMPLER_ARG),
    delay: positive(source.OTEL_BSP_SCHEDULE_DELAY, 5000),
    maxBatch: positive(source.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 512),
    maxQueue: positive(source.OTEL_BSP_MAX_QUEUE_SIZE, 2048),
  };
}

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/// `k1=v1,k2=v2` (values percent-decoded), as OTEL_EXPORTER_OTLP_HEADERS.
export function parseHeaders(raw) {
  const out = {};
  for (const part of String(raw ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {}
    if (k) out[k] = v;
  }
  return out;
}

/// `{ parent: boolean, ratio: number }`: whether a sampled / unsampled parent decides, and the root
/// ratio (always_on = 1, always_off = 0). Unknown names fall back to parentbased_always_on.
export function parseSampler(name, arg) {
  const n = String(name ?? "").trim().toLowerCase();
  const r = Number(arg);
  const ratio = Number.isFinite(r) && r >= 0 && r <= 1 ? r : 1;
  switch (n) {
    case "always_on":
      return { parent: false, ratio: 1 };
    case "always_off":
      return { parent: false, ratio: 0 };
    case "traceidratio":
      return { parent: false, ratio };
    case "parentbased_always_off":
      return { parent: true, ratio: 0 };
    case "parentbased_traceidratio":
      return { parent: true, ratio };
    default:
      return { parent: true, ratio: 1 };
  }
}

/// The sampling decision for a new span: a parent's flag under a parent-based sampler, else the
/// trace id's low 64 bits against the ratio (the same rule as obs.rs `Sampler::sample`).
export function sample(sampler, traceId, parentSampled) {
  if (sampler.parent && parentSampled !== undefined) return parentSampled;
  if (sampler.ratio >= 1) return true;
  if (sampler.ratio <= 0) return false;
  const low = BigInt(`0x${traceId.slice(16)}`) >> 11n;
  return Number(low) / 2 ** 53 < sampler.ratio;
}

const HEX = /^[0-9a-f]+$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/// W3C `traceparent` → `{ traceId, spanId, sampled }`, or null when it is malformed.
export function parseTraceparent(value) {
  if (typeof value !== "string") return null;
  const p = value.trim().split("-");
  if (p.length < 4 || p[0].length !== 2 || p[0] === "ff" || !HEX.test(p[0])) return null;
  if (p[0] === "00" && p.length !== 4) return null;
  const [, traceId, spanId, flags] = p;
  if (traceId.length !== 32 || !HEX.test(traceId) || traceId === ZERO_TRACE) return null;
  if (spanId.length !== 16 || !HEX.test(spanId) || spanId === ZERO_SPAN) return null;
  if (flags.length !== 2 || !HEX.test(flags)) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId, spanId, sampled) {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

// Ids come from a pool of random bytes refilled 4 KiB at a time: a traced request makes several,
// and one getRandomValues call per id showed up in its cost.
const HEX_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
let pool = new Uint8Array(0);
let poolAt = 0;
function randomHex(bytes) {
  if (poolAt + bytes > pool.length) {
    pool = crypto.getRandomValues(new Uint8Array(4096));
    poolAt = 0;
  }
  let s = "";
  for (let i = 0; i < bytes; i++) s += HEX_BYTE[pool[poolAt++]];
  return s;
}
export const newTraceId = () => randomHex(16);
export const newSpanId = () => randomHex(8);

/// Wall-clock time in nanoseconds since the epoch, as the decimal string OTLP JSON uses.
export function nowNanos() {
  const ms = (globalThis.performance?.timeOrigin ?? 0) + (globalThis.performance?.now() ?? Date.now());
  return `${Math.round(ms * 1000)}000`;
}

function attrValue(v) {
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: String(v) };
}

/// One OTLP span (`span` is `{ traceId, spanId, parentSpanId, name, kind, start, end, attrs, error }`).
export function otlpSpan(span) {
  const out = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.start,
    endTimeUnixNano: span.end,
    attributes: Object.entries(span.attrs ?? {}).map(([key, value]) => ({ key, value: attrValue(value) })),
    status: span.error ? { code: 2 } : {},
  };
  if (span.parentSpanId) out.parentSpanId = span.parentSpanId;
  return out;
}

/// The `/v1/traces` request body for `spans` from this process.
export function otlpBody(resource, spans) {
  return {
    resourceSpans: [
      {
        resource: { attributes: Object.entries(resource).map(([key, value]) => ({ key, value: attrValue(value) })) },
        scopeSpans: [{ scope: SCOPE, spans: spans.map(otlpSpan) }],
      },
    ],
  };
}

/// A bounded batch exporter: spans queue up to `maxQueue` (more are dropped), and go out in one
/// POST when `maxBatch` are waiting or `delay` ms after the first. Never awaited by a request; a
/// worker passes `flush()` to `waitUntil`.
export function createExporter(config, { runtime = "node" } = {}) {
  const resource = {
    "service.name": config.serviceName,
    "service.instance.id": newSpanId() + newSpanId(),
    "telemetry.sdk.name": "nowaki",
    "telemetry.sdk.language": "nodejs",
    "process.runtime.name": runtime,
  };
  let queue = [];
  let timer = null;
  let warned = false;
  const send = (spans) =>
    fetch(config.endpoint, {
      method: "POST",
      headers: { ...config.headers, "content-type": "application/json" },
      body: JSON.stringify(otlpBody(resource, spans)),
    }).then(
      (r) => {
        r.body?.cancel?.();
        if (!r.ok) warnOnce(`HTTP ${r.status}`);
      },
      (err) => warnOnce(err?.message ?? String(err)),
    );
  const warnOnce = (why) => {
    if (warned) return;
    warned = true;
    console.warn(`[nowaki] OTLP export to ${config.endpoint} failed (${why}); spans are dropped until it answers`);
  };
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return Promise.resolve();
    const spans = queue;
    queue = [];
    return send(spans);
  };
  return {
    resource,
    add(span) {
      if (queue.length >= config.maxQueue) return;
      queue.push(span);
      if (queue.length >= config.maxBatch) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, config.delay);
        timer?.unref?.();
      }
    },
    flush,
    get pending() {
      return queue.length;
    },
  };
}
