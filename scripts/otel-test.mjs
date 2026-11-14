// Unit test for server/otel.mjs, trace.mjs and log.mjs: traceparent, sampler and OTLP span shape
// against the fixture obs.rs also tests (crates/nowaki/tests/fixtures/otel-cases.json), the
// Server-Timing header, `env.trace` being null when everything is off, the exporter's batching and
// bounds, the @opentelemetry/api bridge, and NOWAKI_LOG=json lines.
// Usage: node scripts/otel-test.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = (f) => pathToFileURL(path.join(ROOT, "packages/nowaki-runtime/server", f)).href;
const otel = await import(server("otel.mjs"));
const { createTrace, traceFromEnv } = await import(server("trace.mjs"));
const fixture = JSON.parse(readFileSync(path.join(ROOT, "crates/nowaki/tests/fixtures/otel-cases.json"), "utf8"));

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
  if (!cond) failures++;
};
const same = isDeepStrictEqual;

for (const c of fixture.traceparent) {
  const got = otel.parseTraceparent(c.input);
  const want = c.traceId ? { traceId: c.traceId, spanId: c.spanId, sampled: c.sampled } : null;
  check(`traceparent ${JSON.stringify(c.input)}`, same(got, want), got);
}
check("traceparent format", otel.formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", false) === "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
for (const c of fixture.sampler) {
  const s = otel.parseSampler(c.name, c.arg);
  check(`sampler ${c.name}(${c.arg}) parent=${c.parentSampled} ${c.traceId.slice(16)}`, otel.sample(s, c.traceId, c.parentSampled ?? undefined) === c.sampled);
}
const input = fixture.span.input;
const span = otel.otlpSpan({ ...input, attrs: Object.fromEntries(input.attrs) });
check("OTLP span shape matches the fixture (and obs.rs)", same(span, fixture.span.otlp), span);
const body = otel.otlpBody({ "service.name": "app" }, [{ ...input, attrs: Object.fromEntries(input.attrs) }]);
check("OTLP body: resource + scope + spans", body.resourceSpans[0].resource.attributes[0].value.stringValue === "app" && body.resourceSpans[0].scopeSpans[0].scope.name === "nowaki" && same(body.resourceSpans[0].scopeSpans[0].spans[0], fixture.span.otlp));

check("config: off without an endpoint", otel.otelConfig({}) === null);
check("config: off with OTEL_SDK_DISABLED", otel.otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_SDK_DISABLED: "true" }) === null);
const cfg = otel.otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example/", OTEL_EXPORTER_OTLP_HEADERS: "a=b%20c,bad, d = e", OTEL_SERVICE_NAME: "shop" });
check("config: endpoint + /v1/traces, headers, service name", cfg.endpoint === "https://otlp.example/v1/traces" && same(cfg.headers, { a: "b c", d: "e" }) && cfg.serviceName === "shop");
check("config: the traces endpoint is used as given", otel.otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b/x" }).endpoint === "http://b/x");

check("env.trace is null when everything is off", traceFromEnv({}) === null && createTrace({}) === null);

// Server-Timing: phases that ran, in order, after a header the response already had.
const timing = createTrace({ timing: true });
const tr = timing.start("GET", () => undefined, "/x");
const a = tr.begin("loader", "loader");
const b = tr.begin("mw", "middleware /");
tr.end(b);
tr.end(a);
const r = tr.begin("render", "render");
tr.end(r);
tr.end(tr.begin(null, "fn x"));
const headers = { "server-timing": "app;dur=1" };
tr.finish(headers, 200);
check("Server-Timing: app's entry first, then mw / loader / render", /^app;dur=1, mw;dur=\d+\.\d, loader;dur=\d+\.\d, render;dur=\d+\.\d$/.test(headers["server-timing"]), headers);
check("timing only: no spans, no route header", tr.traceId === undefined && headers["x-nowaki-route"] === undefined);

// The exporter: spans in a trace, the route header only when asked for, bounded queue.
const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url, init });
  return new Response("{}");
};
const traced = createTrace({ otel: { ...otel.otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" }), delay: 60000 } });
traced.routeHeader = true;
const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const rt = traced.start("GET", (n) => (n === "traceparent" ? parent : undefined), "/blog/a");
rt.setRoute("/blog/[slug]");
rt.end(rt.begin("loader", "loader"));
const h2 = {};
rt.finish(h2, 200);
check("traced: no Server-Timing unless asked for", h2["server-timing"] === undefined);
check("traced: x-nowaki-route for the Rust front", h2["x-nowaki-route"] === "/blog/[slug]");
check("traced: the trace id comes from traceparent", rt.traceId === "4bf92f3577b34da6a3ce929d0e0e4736" && /^[0-9a-f]{16}$/.test(rt.spanId));
check("traced: spans wait for the batch", traced.exporter.pending === 2 && posts.length === 0);
await traced.flush();
const sent = JSON.parse(posts[0]?.init?.body ?? "{}").resourceSpans?.[0];
const sentSpans = sent?.scopeSpans?.[0]?.spans ?? [];
const root = sentSpans.find((s) => s.kind === 2);
check("flush: one POST to /v1/traces with both spans", posts.length === 1 && posts[0].url === "http://c/v1/traces" && sentSpans.length === 2);
check("flush: the root is `GET /blog/[slug]` under the incoming span", root?.name === "GET /blog/[slug]" && root.parentSpanId === "00f067aa0ba902b7" && root.attributes.some((x) => x.key === "http.route"));
check("flush: the loader span is the root's child", sentSpans.some((s) => s.name === "loader" && s.parentSpanId === root?.spanId));
check("resource: service name, a random instance id, the sdk", sent.resource.attributes.some((x) => x.key === "service.instance.id") && sent.resource.attributes.some((x) => x.key === "service.name" && x.value.stringValue === "nowaki"));
const unsampled = traced.start("GET", () => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00", "/");
check("an unsampled parent: no span", unsampled.traceId === undefined && unsampled.begin("loader", "loader").span === null);
const small = otel.createExporter({ ...cfg, endpoint: "http://c", maxQueue: 3, maxBatch: 100, delay: 60000 });
for (let i = 0; i < 10; i++) small.add({ traceId: "a", spanId: "b", name: "x", kind: 1, start: "1", end: "2" });
check("exporter: a full queue drops spans", small.pending === 3);
small.flush();

// The bridge: an app that registered @opentelemetry/api's tracer gets Nowaki's spans in it.
const started = [];
const KEY = Symbol.for("opentelemetry.js.api.1");
globalThis[KEY] = {
  version: "1.9.0",
  trace: {
    getTracer: () => ({
      startSpan(name, opts, ctx) {
        const s = {
          name,
          opts,
          parent: ctx?.getValue?.(Symbol.for("OpenTelemetry Context Key SPAN")),
          ended: false,
          attrs: {},
          spanContext: () => ({ traceId: "1".repeat(32), spanId: String(started.length).padStart(16, "0"), traceFlags: 1 }),
          end() {
            this.ended = true;
          },
          updateName(n) {
            this.name = n;
          },
          setAttribute(k, v) {
            this.attrs[k] = v;
          },
          setStatus(st) {
            this.status = st;
          },
        };
        started.push(s);
        return s;
      },
    }),
  },
};
const bridged = createTrace({});
check("bridge: a registered @opentelemetry/api tracer turns tracing on", bridged !== null && bridged.exporter === null);
const bt = bridged.start("POST", () => undefined, "/form");
bt.setRoute("/form");
bt.end(bt.begin("action", "action"), new Error("x"));
bt.finish({}, 500);
check("bridge: root SERVER span renamed after the route, ended with an error status", started[0].name === "POST /form" && started[0].opts.kind === 1 && started[0].ended && started[0].status?.code === 2 && started[0].attrs["http.route"] === "/form");
check("bridge: the action span is a child of the root", started[1].name === "action" && started[1].parent === started[0] && started[1].ended && started[1].status?.code === 2);
check("bridge: log ids come from the span context", bt.traceId === "1".repeat(32));
delete globalThis[KEY];

// log.mjs reads NOWAKI_LOG at import, so each mode runs in its own process.
const logScript = `
  const { logError, logWarn } = await import(${JSON.stringify(server("log.mjs"))});
  logWarn("careful", { scope: "live" });
  logError("route failed:", new Error("boom"), { trace: { traceId: "${"a".repeat(32)}", spanId: "${"b".repeat(16)}" } });
`;
const run = (mode) => spawnSync(process.execPath, ["--input-type=module", "-e", logScript], { env: { ...process.env, NOWAKI_LOG: mode }, encoding: "utf8" });
const j = run("json");
const lines = (j.stdout + j.stderr).split("\n").filter(Boolean);
const parsed = lines.map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
});
check("NOWAKI_LOG=json: every line parses", lines.length === 2 && parsed.every(Boolean), lines);
const [warn, error] = [parsed.find((p) => p?.level === "warn"), parsed.find((p) => p?.level === "error")];
check("json log: time / level / msg / source", typeof warn?.time === "string" && warn.msg === "careful" && warn.source === "node:live");
check("json log: trace_id / span_id and the error's stack", error?.trace_id === "a".repeat(32) && error.span_id === "b".repeat(16) && /boom/.test(error.error?.stack ?? "") && error.msg === "route failed:");
const t = run("");
check("text logs read as before", /^\[nowaki live\] careful$/m.test(t.stderr) && /^\[nowaki\] route failed: Error: boom/m.test(t.stderr), t.stderr);

if (failures) {
  console.error(`otel: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("otel: all checks passed");
