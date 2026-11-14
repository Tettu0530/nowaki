// Observability end to end on `nowaki start` (examples/hello, built first if needed). A local
// OTLP/HTTP receiver collects the spans of the Rust front and the Node sidecar, and the script
// checks that one request is one trace (client traceparent → Rust SERVER → CLIENT → Node SERVER →
// middleware / loader / render), that a Jetstream WS event is traced across both, that
// Server-Timing is there with NOWAKI_SERVER_TIMING=1 (and an ISR hit doesn't replay a render's
// timings), that NOWAKI_LOG=json lines parse (a failing loader's line carries the trace and the
// stack), and /__nowaki/health. Then the same app with all of it off. e2e-prod.sh runs it.
// Usage: node scripts/otel-e2e.mjs [--port 5560]   (uses port, port+1, port+2)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "examples/hello");
const BIN = path.join(ROOT, "target/debug", process.platform === "win32" ? "nowaki.exe" : "nowaki");
const at = process.argv.indexOf("--port");
const PORT = at > 0 ? Number(process.argv[at + 1]) : 5560;
const RECEIVER = PORT;
const START = PORT + 1;
const PLAIN = PORT + 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || detail === undefined ? "" : `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
  if (!cond) failures++;
};

if (!existsSync(path.join(APP, "dist/client/manifest.json"))) {
  const r = spawnSync(BIN, ["build", APP], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}

// The receiver: every span of every POST /v1/traces, with its resource attributes.
const spans = [];
const bodies = [];
const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/v1/traces") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push({ body, headers: req.headers });
      for (const rs of body.resourceSpans ?? []) {
        const resource = Object.fromEntries((rs.resource?.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
        for (const ss of rs.scopeSpans ?? []) {
          for (const s of ss.spans ?? []) {
            const attrs = Object.fromEntries((s.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
            spans.push({ ...s, attrs, resource });
          }
        }
      }
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise((r) => receiver.listen(RECEIVER, "127.0.0.1", r));

const children = new Set();
process.on("exit", () => {
  for (const c of children) c.kill();
});

async function start(port, env) {
  const child = spawn(BIN, ["start", APP, "--port", String(port)], {
    env: { ...process.env, NOWAKI_ISR_WARM: "0", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/__nowaki/health`)).ok) break;
    } catch {}
    await sleep(250);
  }
  return {
    log: () => out,
    stop: async () => {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      children.delete(child);
    },
  };
}

const waitFor = async (pred, ms = 8000) => {
  for (let i = 0; i < ms / 100; i++) {
    const v = pred();
    if (v) return v;
    await sleep(100);
  }
  return pred();
};

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- 1. Everything on ----
const server = await start(START, {
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${RECEIVER}`,
  OTEL_EXPORTER_OTLP_HEADERS: "x-e2e-key=secret%20value",
  OTEL_SERVICE_NAME: "hello-e2e",
  OTEL_BSP_SCHEDULE_DELAY: "100",
  NOWAKI_SERVER_TIMING: "1",
  NOWAKI_LOG: "json",
});
const B = `http://127.0.0.1:${START}`;

const health = await fetch(`${B}/__nowaki/health`);
check("start: /__nowaki/health is 200 {status:ok}, no-store", health.status === 200 && (await health.text()) === '{"status":"ok"}' && health.headers.get("cache-control") === "no-store");

const clientTrace = hex(16);
const clientSpan = hex(8);
const home = await fetch(`${B}/`, { headers: { traceparent: `00-${clientTrace}-${clientSpan}-01` } });
await home.text();
const st = home.headers.get("server-timing") ?? "";
check("start: Server-Timing has the sidecar's mw / loader / render and the front's total", /\bmw;dur=[\d.]+/.test(st) && /\bloader;dur=[\d.]+/.test(st) && /\brender;dur=[\d.]+/.test(st) && /\btotal;dur=[\d.]+$/.test(st), st);
check("start: the internal route header is stripped", !home.headers.has("x-nowaki-route"));

const trace = (id) => spans.filter((s) => s.traceId === id);
await waitFor(() => trace(clientTrace).some((s) => s.name === "render") && trace(clientTrace).some((s) => s.resource["telemetry.sdk.language"] === "rust" && s.kind === 2));
const t = trace(clientTrace);
const byName = (name, lang) => t.find((s) => s.name === name && (!lang || s.resource["telemetry.sdk.language"] === lang));
const rustServer = t.find((s) => s.kind === 2 && s.resource["telemetry.sdk.language"] === "rust");
const rustClient = t.find((s) => s.kind === 3);
const nodeServer = t.find((s) => s.kind === 2 && s.resource["telemetry.sdk.language"] === "nodejs");
check("trace: the Rust SERVER span is `GET /`, child of the client's span", rustServer?.name === "GET /" && rustServer.parentSpanId === clientSpan, rustServer);
check("trace: SERVER span attributes", rustServer?.attrs["http.route"] === "/" && rustServer.attrs["url.path"] === "/" && rustServer.attrs["http.response.status_code"] === "200" && rustServer.attrs["http.request.method"] === "GET", rustServer?.attrs);
check("trace: a CLIENT span to the sidecar under it", rustClient?.parentSpanId === rustServer?.spanId);
check("trace: the Node SERVER span is a child of the CLIENT span", nodeServer?.name === "GET /" && nodeServer.parentSpanId === rustClient?.spanId, nodeServer);
for (const name of ["middleware /", "loader", "render"]) {
  const s = byName(name, "nodejs");
  check(`trace: Node \`${name}\` span under the Node SERVER span`, s?.parentSpanId === nodeServer?.spanId && Number(s.endTimeUnixNano) >= Number(s.startTimeUnixNano));
}
const instances = new Set(t.map((s) => s.resource["service.instance.id"]));
check("trace: spans from two service instances (front + sidecar), one service name", instances.size === 2 && t.every((s) => s.resource["service.name"] === "hello-e2e"), [...instances]);
check("export: OTEL_EXPORTER_OTLP_HEADERS reach the collector (percent-decoded)", bodies.length > 0 && bodies.every((b) => b.headers["x-e2e-key"] === "secret value"));

// Without a client traceparent the front starts the trace.
await (await fetch(`${B}/about`)).text();
await waitFor(() => spans.some((s) => s.name === "GET /about" && s.resource["telemetry.sdk.language"] === "rust"));
const about = spans.find((s) => s.name === "GET /about" && s.resource["telemetry.sdk.language"] === "rust");
// The two exporters flush on their own timers: wait for the sidecar's half of the trace too.
await waitFor(() => spans.some((s) => s.traceId === about?.traceId && s.resource["telemetry.sdk.language"] === "nodejs"));
check("trace: a request without traceparent gets a root SERVER span", !!about && !about.parentSpanId && /^[0-9a-f]{32}$/.test(about.traceId));
check("trace: and the sidecar's spans join it", spans.some((s) => s.traceId === about?.traceId && s.resource["telemetry.sdk.language"] === "nodejs"));

// ISR: the MISS carries the render's timings; a HIT has only the front's and never replays them.
const miss = await fetch(`${B}/isr`);
await miss.text();
const hit = await fetch(`${B}/isr`);
await hit.text();
const missT = miss.headers.get("server-timing") ?? "";
const hitT = hit.headers.get("server-timing") ?? "";
check("ISR MISS: render timings + isr;desc=MISS + total", /render;dur=/.test(missT) && /isr;desc=MISS, total;dur=/.test(missT), missT);
check("ISR HIT: only isr;desc=HIT and total", /^isr;desc=HIT, total;dur=[\d.]+$/.test(hitT), hitT);
await waitFor(() => spans.some((s) => s.attrs["nowaki.isr"] === "HIT"));
check("trace: an ISR hit is a SERVER span with nowaki.isr=HIT and no sidecar hop", spans.some((s) => s.attrs["nowaki.isr"] === "HIT" && s.name === "GET /isr" && !spans.some((c) => c.parentSpanId === s.spanId)));

// A Jetstream WS event: a Rust `live LiveCounter` span with the sidecar's as its child.
const liveHtml = await (await fetch(`${B}/live`)).text();
const tag = liveHtml.match(/<nowaki-live\b[^>]*>/)?.[0] ?? "";
const attr = (n) => tag.match(new RegExp(`${n}="([^"]*)"`))?.[1];
const ws = new WebSocket(`${B.replace(/^http/, "ws")}/__nowaki/live`);
await new Promise((r, j) => {
  ws.addEventListener("open", r);
  ws.addEventListener("error", j);
});
const patched = new Promise((r) => ws.addEventListener("message", (e) => JSON.parse(e.data).type === "patch" && r()));
ws.send(JSON.stringify({ type: "join", islands: [{ nid: attr("nid"), name: "LiveCounter", state: JSON.parse((attr("state") ?? "{}").replace(/&quot;/g, '"')), sig: attr("sig") }] }));
ws.send(JSON.stringify({ type: "event", nid: attr("nid"), handler: "inc" }));
await Promise.race([patched, sleep(5000)]);
ws.close();
const liveRust = await waitFor(() => spans.find((s) => s.name === "live LiveCounter" && s.resource["telemetry.sdk.language"] === "rust"));
const liveNode = await waitFor(() => spans.find((s) => s.name === "live LiveCounter" && s.resource["telemetry.sdk.language"] === "nodejs"));
check("trace: a live WS event span in Rust", !!liveRust && liveRust.attrs["nowaki.live.kind"] === "event");
check("trace: the sidecar's live span is its child", liveNode?.traceId === liveRust?.traceId && liveNode?.parentSpanId === liveRust?.spanId);

// A failing loader: a 500 whose JSON log line names the trace and carries the stack.
const boomTrace = hex(16);
const boom = await fetch(`${B}/boom?boom=1`, { headers: { traceparent: `00-${boomTrace}-${hex(8)}-01` } });
const boomBody = await boom.text();
check("a 500 stays generic to the client", boom.status === 500 && !boomBody.includes("at "));
await waitFor(() => server.log().includes(boomTrace));
await sleep(300);

const lines = server.log().split(/\r?\n/).filter((l) => l.trim());
const json = [];
const notJson = [];
for (const l of lines) {
  if (l.startsWith("NOWAKI_START_READY ")) continue;
  try {
    json.push(JSON.parse(l));
  } catch {
    notJson.push(l);
  }
}
check("NOWAKI_LOG=json: every line (but the READY marker) is one JSON object", notJson.length === 0, notJson.slice(0, 5));
check("logs: each has time / level / msg / source", json.length > 0 && json.every((j) => typeof j.time === "string" && typeof j.level === "string" && typeof j.msg === "string" && typeof j.source === "string"));
const access = json.find((j) => j.msg === "request" && j.path === "/" && j.trace_id === clientTrace);
check("logs: an access log line per request, with trace_id / span_id", access?.source === "rust" && access.status === 200 && typeof access.dur_ms === "number" && /^[0-9a-f]{16}$/.test(access.span_id ?? ""), access);
const err = json.find((j) => j.level === "error" && j.trace_id === boomTrace);
check("logs: the 500's error line comes from node with the request's trace and the stack", err?.source === "node" && /Intentional error/.test(err.error?.stack ?? ""), err);
await server.stop();

// ---- 2. Everything off ----
const plain = await start(PLAIN, {});
const P = `http://127.0.0.1:${PLAIN}`;
const before = spans.length;
const off = await fetch(`${P}/`, { headers: { traceparent: `00-${hex(16)}-${hex(8)}-01` } });
await off.text();
check("off: no Server-Timing", !off.headers.has("server-timing"));
await (await fetch(`${P}/isr`)).text();
const offHit = await fetch(`${P}/isr`);
await offHit.text();
check("off: an ISR hit has no Server-Timing either", offHit.headers.get("x-nowaki-cache") === "HIT" && !offHit.headers.has("server-timing"));
check("off: /__nowaki/health still answers", (await fetch(`${P}/__nowaki/health`)).status === 200);
await sleep(500);
check("off: nothing exported", spans.length === before);
check("off: no access log, the usual banner", !/"msg":"request"/.test(plain.log()) && /Nowaki \(production\)/.test(plain.log()));
await plain.stop();

receiver.close();
if (failures) {
  console.error(`otel e2e: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("otel e2e: all checks passed");
