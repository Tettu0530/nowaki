// Per-request tracing behind `env.trace`: Server-Timing phases and OpenTelemetry spans. `env.trace`
// is null unless one of them is on, and the handler only does `tr?.…` per mark, so a request pays
// one null check per phase and allocates nothing when both are off. Runtime-neutral (the worker
// uses it too).

import { createExporter, formatTraceparent, newSpanId, newTraceId, nowNanos, otelConfig, parseTraceparent, sample, SPAN_KIND } from "./otel.mjs";

const PHASES = ["mw", "loader", "render", "action"];
const PHASE_INDEX = { mw: 0, loader: 1, render: 2, action: 3 };
const now = () => globalThis.performance?.now() ?? Date.now();
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/// `env.trace` from the environment: Server-Timing with NOWAKI_SERVER_TIMING=1 (or `timing`),
/// OTLP export with the OTEL_* variables, or the app's own `@opentelemetry/api` tracer when one is
/// registered. Null when none of them is on.
export function traceFromEnv(source = globalThis.process?.env ?? {}, { timing, runtime } = {}) {
  return createTrace({ timing: timing ?? truthy(source.NOWAKI_SERVER_TIMING), otel: otelConfig(source), runtime });
}

// The global that @opentelemetry/api registers its providers on (major version 1).
function otelApi() {
  const g = globalThis[Symbol.for("opentelemetry.js.api.1")];
  return g?.trace && typeof g.trace.getTracer === "function" ? g : null;
}

export function createTrace({ timing = false, otel = null, runtime } = {}) {
  const api = otelApi();
  if (!timing && !otel && !api) return null;
  const exporter = !api && otel ? createExporter(otel, { runtime }) : null;
  return {
    timing,
    sampler: otel?.sampler ?? { parent: true, ratio: 1 },
    exporter,
    api,
    tracer: api ? api.trace.getTracer("nowaki") : null,
    // Set by prod-sidecar.mjs: `nowaki start` names its SERVER span after the route (x-nowaki-route).
    routeHeader: false,
    /// `get(name)` reads a request header (`traceparent` is the parent span).
    start(method, get, path) {
      return new RequestTrace(this, method, get, path);
    },
    flush() {
      return exporter ? exporter.flush() : Promise.resolve();
    },
  };
}

// A minimal Context for the bridge when the app registered no context manager.
class Ctx {
  constructor(m = new Map()) {
    this.m = m;
  }
  getValue(k) {
    return this.m.get(k);
  }
  setValue(k, v) {
    const m = new Map(this.m);
    m.set(k, v);
    return new Ctx(m);
  }
  deleteValue(k) {
    const m = new Map(this.m);
    m.delete(k);
    return new Ctx(m);
  }
}
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
const headerGetter = { get: (get, k) => get?.(k) ?? undefined, keys: () => ["traceparent", "tracestate"] };

class RequestTrace {
  constructor(owner, method, get, path) {
    this.o = owner;
    this.method = method;
    this.t0 = now();
    this.d = owner.timing ? [0, 0, 0, 0] : null;
    this.ran = 0;
    this.route = null;
    this.root = null;
    this.ctx = null;
    const attrs = { "http.request.method": method };
    if (path) attrs["url.path"] = path;
    if (owner.exporter) {
      const parent = parseTraceparent(get?.("traceparent"));
      const traceId = parent?.traceId ?? newTraceId();
      if (sample(owner.sampler, traceId, parent?.sampled)) {
        this.root = { traceId, spanId: newSpanId(), parentSpanId: parent?.spanId, name: method, kind: SPAN_KIND.server, start: nowNanos(), end: null, attrs, error: false };
      }
    } else if (owner.tracer) {
      const api = owner.api;
      const active = api.context?.active?.() ?? new Ctx();
      const parentCtx = api.propagation?.extract ? api.propagation.extract(active, get, headerGetter) : active;
      // SpanKind.SERVER is 1 in @opentelemetry/api.
      this.root = owner.tracer.startSpan(method, { kind: 1, attributes: attrs }, parentCtx);
      this.ctx = parentCtx.setValue(SPAN_KEY, this.root);
    }
  }

  get traceId() {
    const r = this.root;
    return r ? (r.traceId ?? r.spanContext?.().traceId) : undefined;
  }

  get spanId() {
    const r = this.root;
    return r ? (r.spanId ?? r.spanContext?.().spanId) : undefined;
  }

  /// The `traceparent` for a call this request makes (the root span as parent).
  traceparent() {
    const r = this.root;
    if (!r) return undefined;
    if (r.traceId) return formatTraceparent(r.traceId, r.spanId, true);
    const c = r.spanContext();
    return formatTraceparent(c.traceId, c.spanId, (c.traceFlags & 1) === 1);
  }

  /// `phase` is a Server-Timing entry (mw, loader, render, action) or null; `name` the span's.
  begin(phase, name) {
    let span = null;
    const r = this.root;
    if (r) {
      if (this.o.exporter) {
        span = { traceId: r.traceId, spanId: newSpanId(), parentSpanId: r.spanId, name, kind: SPAN_KIND.internal, start: nowNanos(), end: null, attrs: null, error: false };
      } else {
        span = this.o.tracer.startSpan(name, { kind: 0 }, this.ctx);
      }
    }
    return { p: phase === null ? -1 : PHASE_INDEX[phase], t: this.d ? now() : 0, span };
  }

  end(tok, err) {
    if (this.d && tok.p >= 0) {
      this.d[tok.p] += now() - tok.t;
      this.ran |= 1 << tok.p;
    }
    const s = tok.span;
    if (!s) return;
    if (this.o.exporter) {
      s.end = nowNanos();
      if (err) s.error = true;
      this.o.exporter.add(s);
    } else {
      if (err) s.setStatus?.({ code: 2, message: String(err?.message ?? err) });
      s.end();
    }
  }

  /// The matched route's pattern ("/blog/[slug]"), which names the request's span.
  setRoute(pattern) {
    this.route = pattern;
  }

  /// Renames the root span (a live event: `live <island>`).
  rename(name) {
    const r = this.root;
    if (!r) return;
    if (this.o.exporter) r.name = name;
    else r.updateName?.(name);
  }

  /// Called once with the response headers, before they go out (streamed bodies may still run).
  finish(headers, status) {
    if (this.d && this.ran) {
      let st = "";
      for (let i = 0; i < 4; i++) {
        if (this.ran & (1 << i)) st += `${st ? ", " : ""}${PHASES[i]};dur=${this.d[i].toFixed(1)}`;
      }
      const prev = headers["server-timing"];
      headers["server-timing"] = prev ? `${prev}, ${st}` : st;
    }
    const r = this.root;
    if (!r) return;
    if (this.route && this.o.routeHeader) headers["x-nowaki-route"] = this.route;
    const name = this.route ? `${this.method} ${this.route}` : null;
    if (this.o.exporter) {
      if (name) r.name = name;
      if (this.route) r.attrs["http.route"] = this.route;
      r.attrs["http.response.status_code"] = status;
      r.error = status >= 500;
      r.end = nowNanos();
      this.o.exporter.add(r);
    } else {
      if (name) r.updateName?.(name);
      if (this.route) r.setAttribute?.("http.route", this.route);
      r.setAttribute?.("http.response.status_code", status);
      if (status >= 500) r.setStatus?.({ code: 2 });
      r.end();
    }
  }
}
