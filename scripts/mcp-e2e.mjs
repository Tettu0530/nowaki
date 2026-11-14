// The `nowaki dev` MCP endpoint (/__nowaki/mcp) end to end, against examples/hello under
// `nowaki dev` (e2e-dev.sh runs it): initialize, tools/list, each tool, the loopback / Host /
// Origin gate (also on the dev toolbar's GET /__nowaki/devtools), and that the sidecar's
// /__nowaki/dev-info is not proxied.
// Usage: node scripts/mcp-e2e.mjs http://127.0.0.1:<port>

import http from "node:http";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const MCP = `${BASE}/__nowaki/mcp`;
let failed = 0;
let nextId = 1;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}

// node:http so the test can set Host (fetch treats it as a forbidden header).
function post(body, headers = {}, method = "POST", target = MCP) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(typeof body === "string" ? body : JSON.stringify(body));
    else req.end();
  });
}

async function rpc(method, params) {
  const id = nextId++;
  const r = await post({ jsonrpc: "2.0", id, method, params }, { "mcp-protocol-version": "2025-06-18" });
  if (r.status !== 200 || r.json?.id !== id) throw new Error(`${method}: HTTP ${r.status} ${r.text}`);
  return r.json;
}

async function call(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.result;
}

console.log(`MCP e2e against ${MCP}`);

const init = await post({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-e2e", version: "1" } },
});
check("initialize returns 200 JSON", init.status === 200 && /application\/json/.test(init.headers["content-type"]), init.status);
check("initialize echoes a supported protocol version", init.json?.result?.protocolVersion === "2025-06-18", init.json);
check("initialize advertises tools", typeof init.json?.result?.capabilities?.tools === "object", init.json);
check("serverInfo names the server", init.json?.result?.serverInfo?.name === "nowaki-dev", init.json);

const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
check("notification gets 202 Accepted", notified.status === 202, notified.status);

const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
for (const n of ["routes", "module_graph", "recent_errors", "dev_config", "page", "live"]) {
  check(`tools/list has ${n}`, names.includes(n), names);
}

const routes = (await call("routes")).structuredContent;
const patterns = routes.routes.map((r) => r.pattern);
check("routes include /live", patterns.includes("/live"), patterns);
check("routes include /poll", patterns.includes("/poll"), patterns);
check("routes include the dynamic /blog/[slug]", patterns.includes("/blog/[slug]"), patterns);
const api = routes.routes.find((r) => r.pattern === "/api/hello");
check("/api/hello is kind api", api?.kind === "api" && api.file === "routes/api/hello.ts", api);
const isr = routes.routes.find((r) => r.pattern === "/isr");
check("/isr reports its revalidate export", isr?.revalidate === 2, isr);
check(
  "conventions list the root layout and middleware",
  routes.conventions.some((c) => c.kind === "layout" && c.prefix === "/") &&
    routes.conventions.some((c) => c.kind === "middleware"),
  routes.conventions,
);
check("routes report the CSP mode", typeof routes.csp === "string", routes.csp);

const graph = (await call("module_graph", { file: "routes/live.tsx" })).structuredContent;
check(
  "routes/live.tsx imports islands/LiveCounter.tsx",
  graph.imports.some((i) => i.resolved === "islands/LiveCounter.tsx"),
  graph.imports,
);
const live = graph.islands.find((i) => i.name === "LiveCounter");
const counter = graph.islands.find((i) => i.name === "Counter");
check("LiveCounter is a live island", live?.live === true, graph.islands);
check("Counter is not live", counter?.live === false, graph.islands);
const island = (await call("module_graph", { file: "islands/LiveCounter.tsx" })).structuredContent;
check("islands/LiveCounter.tsx is imported by routes/live.tsx", island.importers.includes("routes/live.tsx"), island);
check("module_graph identifies the file as a live island", island.island?.live === true, island.island);
const outside = await call("module_graph", { file: "../../Cargo.toml" });
check("module_graph refuses files outside the app", outside.isError === true, outside);

const boom = await fetch(`${BASE}/boom?boom=1`);
check("GET /boom?boom=1 is a 500", boom.status === 500, boom.status);
const errors = (await call("recent_errors", { source: "ssr" })).structuredContent;
const ssr = errors.errors[0];
check("recent_errors has the SSR error", ssr?.source === "ssr" && ssr.path === "/boom" && ssr.message.length > 0, errors);
check("the SSR error has a timestamp", typeof ssr?.time === "string" && !Number.isNaN(Date.parse(ssr.time)), ssr);
check("the SSR error points at the route file", ssr?.file?.startsWith("routes/boom.tsx"), ssr);

const config = (await call("dev_config")).structuredContent;
check("dev_config reports the port", String(config.port) === new URL(BASE).port, config);
check("dev_config reports live state", typeof config.live?.connections === "number", config.live);
check("dev_config lists the recent revalidations", Array.isArray(config.revalidations), config.revalidations);

// page: what serves one URL (the dev toolbar reads the same data).
const livePage = (await call("page", { url: "/live" })).structuredContent;
check("page matches /live to routes/live.tsx", livePage.route?.pattern === "/live" && livePage.route.file === "routes/live.tsx", livePage.route);
check("page lists the root layout and middleware", livePage.layouts?.includes("routes/_layout.tsx") && livePage.middleware?.includes("routes/_middleware.ts"), livePage);
const pIsl = (n) => livePage.islands?.find((i) => i.name === n);
check("page: LiveCounter is a live island with no client JS", pIsl("LiveCounter")?.kind === "live" && pIsl("LiveCounter").gzipBytes === 0, livePage.islands);
check("page: Counter is a client island with a size and a could-be-live hint", pIsl("Counter")?.kind === "client" && pIsl("Counter").gzipBytes > 0 && pIsl("Counter").hint?.kind === "could-be-live", pIsl("Counter"));
const est = livePage.js?.estimate;
check(
  "page: first-load JS estimate = runtime + islands + live runtime",
  est?.label === "estimate" && est.runtime > 0 && est.liveRuntime > 0 && est.gzipBytes === est.runtime + est.islands + est.liveRuntime,
  livePage.js,
);
check("page: lastBuild is null or a build figure", livePage.js.lastBuild === null || typeof livePage.js.lastBuild.gzipBytes === "number", livePage.js.lastBuild);
check("page lists the recent revalidations", Array.isArray(livePage.revalidations), livePage);
const isrPage = (await call("page", { url: "/isr-tagged?x=1" })).structuredContent;
check("page reports revalidate and tags", isrPage.route?.revalidate === 300 && JSON.stringify(isrPage.route.tags) === '["isr-demo"]', isrPage.route);
const blog = (await call("page", { url: "/blog/hello" })).structuredContent;
check("page reports the dynamic route's params", blog.route?.pattern === "/blog/[slug]" && blog.route.params?.slug === "hello", blog.route);
const missing = (await call("page", { url: "/no/such/page" })).structuredContent;
check("page: no route for an unknown URL, the 404 page named", missing.route === null && missing.notFound === "routes/_404.tsx", missing);
const badUrl = await call("page", { url: "https://evil.test/" });
check("page refuses a URL that isn't a path", badUrl.isError === true, badUrl);
const noUrl = await call("page", {});
check("page needs a url", noUrl.isError === true, noUrl);

const liveStats = (await call("live")).structuredContent;
check("live reports connections, the cap and rooms", typeof liveStats.connections === "number" && liveStats.max > 0 && Array.isArray(liveStats.rooms), liveStats);

const unknown = await rpc("tools/call", { name: "nope", arguments: {} });
check("unknown tool is a JSON-RPC error", unknown.error?.code === -32602, unknown);

// Gate: DNS rebinding (non-loopback Host), cross-site browser (Origin), wrong method / version.
const port = new URL(BASE).port;
const ping = { jsonrpc: "2.0", id: 99, method: "ping" };
const rebound = await post(ping, { host: `attacker.test:${port}` });
check("non-loopback Host is refused (403)", rebound.status === 403, rebound.status);
const crossSite = await post(ping, { origin: "http://evil.test" });
check("non-loopback Origin is refused (403)", crossSite.status === 403, crossSite.status);
const sameOrigin = await post(ping, { origin: `http://localhost:${port}` });
check("loopback Origin is allowed", sameOrigin.status === 200 && sameOrigin.json?.result, sameOrigin.status);
const get = await post(undefined, {}, "GET");
check("GET is 405 (no SSE stream)", get.status === 405, get.status);
const badVersion = await post(ping, { "mcp-protocol-version": "1999-01-01" });
check("unsupported MCP-Protocol-Version is 400", badVersion.status === 400, badVersion.status);
const parse = await post("{not json");
check("malformed JSON is a parse error", parse.status === 400 && parse.json?.error?.code === -32700, parse.text);

// The dev toolbar's endpoint: the same data behind the same gate.
const DEVTOOLS = `${BASE}/__nowaki/devtools?url=${encodeURIComponent("/live")}`;
const tools = await post(undefined, {}, "GET", DEVTOOLS);
check("devtools answers loopback with JSON", tools.status === 200 && tools.json?.page?.route?.file === "routes/live.tsx", tools.text);
check(
  "devtools carries live stats, errors and the editor template",
  typeof tools.json?.live?.connections === "number" && Array.isArray(tools.json?.errors?.errors) && (tools.json?.editor ?? "").includes("{file}"),
  tools.json,
);
check("devtools is not cacheable", tools.headers["cache-control"] === "no-store", tools.headers);
const toolsRebound = await post(undefined, { host: `attacker.test:${port}` }, "GET", DEVTOOLS);
check("devtools refuses a non-loopback Host (403)", toolsRebound.status === 403, toolsRebound.status);
const toolsCross = await post(undefined, { origin: "http://evil.test" }, "GET", DEVTOOLS);
check("devtools refuses a non-loopback Origin (403)", toolsCross.status === 403, toolsCross.status);
const toolsSame = await post(undefined, { origin: `http://localhost:${port}` }, "GET", DEVTOOLS);
check("devtools allows a loopback Origin", toolsSame.status === 200, toolsSame.status);

const devInfo = await fetch(`${BASE}/__nowaki/dev-info`);
check("sidecar /__nowaki/dev-info is not proxied", devInfo.status === 404, devInfo.status);

if (failed) {
  console.error(`MCP e2e: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("MCP e2e: all checks passed");
