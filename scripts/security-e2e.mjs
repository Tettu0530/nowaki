// App-layer security regression suite. Deterministically checks defenses for regressions (no Chrome). Called from CI e2e.
//   node scripts/security-e2e.mjs dev  <devBase>  <appRoot>
//   node scripts/security-e2e.mjs prod <prodBase>
// Covers (dev + prod unless noted): RPC CSRF, CSWSH, forged live state, the live-event POST gate, server functions,
//         cross-site writes, default headers. Dev only: arbitrary file read (@fs/ssr-module/.env/
//         virtual ..), the HMR socket. Prod only: generic 500s, ISR isolation and query-flood
//         collapsing, /_nowaki/* basename static serving (path traversal).

import http from "node:http";

const [mode, base, appRoot] = process.argv.slice(2);
let fails = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = async (url, opts) => (await fetch(url, opts)).status;

// GET that sends the path verbatim (fetch normalizes `..`, so use raw http).
function rawGet(b, path) {
  const u = new URL(b);
  return new Promise((resolve) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: "GET" },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}

// Attempts a WebSocket upgrade. 101=upgraded, 403 etc.=rejected. Origin can be set freely.
function wsUpgrade(b, path, origin) {
  const u = new URL(b);
  return new Promise((resolve) => {
    const req = http.request({
      host: u.hostname, port: u.port, path, method: "GET",
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==",
        "Sec-WebSocket-Version": "13", Origin: origin,
      },
    });
    req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(0));
    req.end();
  });
}

// Client-sent x-forwarded-host is dropped by the Rust front (no NOWAKI_TRUST_PROXY), so it can
// neither spoof the RPC same-origin check nor break a genuine same-origin call.
async function forwardedHostIgnored(b) {
  const call = (h) =>
    fetch(`${b}/__nowaki/fn`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nowaki-rpc": "1", ...h },
      body: JSON.stringify({ id: "6c90d7dc921a9a3f", args: [] }),
    }).then((r) => r.status);
  check("RPC forged x-forwarded-host can't spoof the origin check (403)",
    (await call({ origin: "http://evil.test", "x-forwarded-host": "evil.test" })) === 403);
  check("RPC same-origin call unaffected by a client x-forwarded-host (200)",
    (await call({ origin: b, "x-forwarded-host": "evil.test" })) === 200);
}

// Server functions: Standard Schema validation (addTodo), body/argument limits, and no internal
// error details in production (brokenTodo throws "db password is hunter2").
async function serverFnHardening(b, m) {
  const rpc = async (body) => {
    const r = await fetch(`${b}/__nowaki/fn`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nowaki-rpc": "1" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {}
    return { status: r.status, data };
  };
  const bad = await rpc({ id: "675f80133a1699f8", args: [""] });
  check("serverFn rejects invalid input (400 + issues)",
    bad.status === 400 && bad.data?.error === "Invalid input" && bad.data?.data?.issues?.length === 1);
  const good = await rpc({ id: "675f80133a1699f8", args: ["  schema-ok  "] });
  check("serverFn passes the validated value", good.status === 200 && good.data?.result?.includes("schema-ok"));
  const broken = await rpc({ id: "96224074eee5e982", args: [] });
  if (m === "prod") {
    check("prod: unexpected server function error is generic (500, no message)",
      broken.status === 500 && broken.data?.error === "Internal Server Error");
  } else {
    check("dev: unexpected server function error keeps its message",
      broken.status === 500 && /hunter2/.test(broken.data?.error ?? ""));
  }
  check("server function argument count limit (400)",
    (await rpc({ id: "6c90d7dc921a9a3f", args: Array(17).fill(0) })).status === 400);
  check("server function body size limit (413)",
    (await rpc(JSON.stringify({ id: "6c90d7dc921a9a3f", args: ["x".repeat(1100 * 1024)] }))).status === 413);
}

// Page actions reject cross-site non-GET requests by default; API routes warn unless they opt in.
async function crossSiteWritesRejected(b) {
  const send = (path, h) =>
    fetch(`${b}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...h },
      body: "text=csrf-check",
    }).then((r) => r.status);
  check("action: cross-site Origin rejected (403)", (await send("/todos", { origin: "http://evil.test" })) === 403);
  check("action: Origin null rejected (403)", (await send("/todos", { origin: "null" })) === 403);
  check("action: Sec-Fetch-Site cross-site rejected (403)",
    (await send("/todos", { "sec-fetch-site": "cross-site" })) === 403);
  check("action: same-origin POST allowed", (await send("/todos", { origin: b })) === 302);
  check("action: POST without Origin (non-browser) allowed", (await send("/todos", {})) === 302);
  check("API with `csrf = true`: cross-site Origin rejected (403)",
    (await send("/api/echo", { origin: "http://evil.test" })) === 403);
  check("API without `csrf`: cross-site Origin still allowed (warn phase)",
    (await send("/api/hello", { origin: "http://evil.test" })) === 200);
}

// Default security headers on pages, 404s, and static assets (both modes) and on ISR hits (prod).
async function securityHeadersPresent(b, paths) {
  for (const p of paths) {
    const h = (await fetch(`${b}${p}`)).headers;
    check(`security headers on ${p}`,
      h.get("x-content-type-options") === "nosniff" &&
        h.get("x-frame-options") === "SAMEORIGIN" &&
        h.get("referrer-policy") === "strict-origin-when-cross-origin" &&
        h.get("cross-origin-opener-policy") === "same-origin" &&
        /frame-ancestors 'self'/.test(h.get("content-security-policy") || ""));
  }
}

// Checks that a forged live join gets no patch (rejected by signature verification).
// The global WebSocket connects without Origin (ws_origin_ok allows it) -> tests the signature alone.
async function liveForgeryRejected(b) {
  const html = await (await fetch(`${b}/live`)).text();
  const tag = html.match(/<nowaki-live\b[^>]*>/)?.[0];
  if (!tag) return false;
  const attr = (n) => tag.match(new RegExp(`${n}="([^"]*)"`))?.[1];
  const nid = attr("nid");
  const name = attr("name");
  const wsUrl = b.replace(/^http/, "ws") + "/__nowaki/live";
  return await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let gotPatch = false;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "join",
        islands: [{ nid, name, state: { count: 9999 }, sig: "FORGED" }],
      }));
      setTimeout(() => ws.send(JSON.stringify({ type: "event", nid, handler: "inc" })), 120);
    });
    ws.addEventListener("message", (e) => {
      try { if (JSON.parse(e.data).type === "patch") gotPatch = true; } catch {}
    });
    setTimeout(() => { ws.close(); resolve(!gotPatch); }, 900);
  });
}

// POST /__nowaki/live-event (the WS fallback) keeps the RPC-style CSRF gate, a body cap, and
// signature verification before any handler.
async function liveEventGate(b) {
  const tag = (await (await fetch(`${b}/live`)).text()).match(/<nowaki-live\b[^>]*>/)?.[0] ?? "";
  const attr = (n) => tag.match(new RegExp(`${n}="([^"]*)"`))?.[1];
  const ev = { name: attr("name"), state: JSON.parse((attr("state") ?? "{}").replace(/&quot;/g, '"')), sig: attr("sig"), handler: "inc" };
  const post = (h, body = ev) =>
    fetch(`${b}/__nowaki/live-event`, {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries({ "content-type": "application/json", "x-nowaki-live": "1", ...h }).filter(([, v]) => v !== null),
      ),
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const ok = await post({ origin: b });
  const okBody = ok.status === 200 ? await ok.json() : {};
  check("live-event same-origin POST applies the event (live: 1, new sig)",
    /live:\s*1/.test(okBody.html ?? "") && okBody.state?.count === 1 && okBody.sig && okBody.sig !== ev.sig);
  check("live-event cross-site Origin rejected (403)", (await post({ origin: "http://evil.test" })).status === 403);
  check("live-event Sec-Fetch-Site cross-site rejected (403)", (await post({ "sec-fetch-site": "cross-site" })).status === 403);
  check("live-event missing x-nowaki-live rejected (403)", (await post({ "x-nowaki-live": null })).status === 403);
  check("live-event text/plain rejected (415)", (await post({ "content-type": "text/plain" })).status === 415);
  const forged = await post({}, { ...ev, state: { count: 9999 }, sig: "FORGED" });
  const forgedText = await forged.text();
  check(`live-event forged signature gets no html (${forged.status})`, forged.status === 403 && !forgedText.includes("html"));
  check("live-event oversized body rejected (413)",
    (await post({}, { ...ev, payload: "x".repeat(70 * 1024) })).status === 413);
  // The sidecar's internal render hook has no CSRF gate, so the Rust front must not proxy it.
  // The POST runs in its own request: live.authorize sees the request's real cookies.
  const admin = (cookie) =>
    fetch(`${b}/__nowaki/live-event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nowaki-live": "1", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ ...ev, handler: "adminReset" }),
    });
  const denied = await admin(null);
  check(`live-event: live.authorize refuses without the role cookie (${denied.status})`,
    denied.status === 403 && (await denied.json()).error === "forbidden");
  check("live-event: live.authorize allows with role=admin", (await admin("role=admin")).status === 200);
  const internal = await fetch(`${b}/__nowaki/live-render`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(ev) });
  check(`internal /__nowaki/live-render not reachable (${internal.status})`, internal.status === 404);
}

if (mode === "dev") {
  const enc = encodeURIComponent;
  // Arbitrary file read surface (canonicalize + allow-root + deny + transformable gates)
  // A file that exists outside every allowed root, so "blocked" means 403 rather than 404.
  const outside = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd";
  const fsUrl = (p) => `${base}/@fs/${p.replace(/\\/g, "/").replace(/^\//, "")}`;
  check(`@fs arbitrary read blocked (${outside} → 403)`,
    (await statusOf(fsUrl(outside))) === 403);
  check("@fs .env blocked (403)",
    (await statusOf(fsUrl(`${appRoot}/.env`))) === 403);
  check(`ssr-module arbitrary read blocked (${outside} → 403)`,
    (await statusOf(`${base}/__nowaki/ssr-module?path=${enc(outside)}`)) === 403);
  check("ssr-module .env blocked (403)",
    (await statusOf(`${base}/__nowaki/ssr-module?path=${enc(appRoot + "/.env")}`)) === 403);
  check("ssr-module legit module still served (200)",
    (await statusOf(`${base}/__nowaki/ssr-module?path=${enc(appRoot + "/routes/index.tsx")}`)) === 200);
  const envRes = await fetch(`${base}/.env`);
  const envBody = await envRes.text();
  check(".env not served via dev fallback (no secret leaked)",
    envRes.status !== 200 && !envBody.includes("SESSION_SECRET"));
  check("virtual-module traversal rejected (.. → 404)",
    (await rawGet(base, "/__nowaki_virtual__/../../../../../../../etc/hosts")) === 404);

  // HMR is dev-only.
  check("CSWSH /__nowaki/hmr cross-origin upgrade rejected (403)",
    (await wsUpgrade(base, "/__nowaki/hmr", "http://evil.test")) === 403);
}

// Checks that hold in both modes (dev and prod share the RPC gate, WS origin checks, live
// signatures, and default headers).
{
  // CSRF gate for server function RPC
  const fn = `${base}/__nowaki/fn`;
  const post = (h) =>
    fetch(fn, { method: "POST", headers: h, body: JSON.stringify({ id: "6c90d7dc921a9a3f", args: [] }) })
      .then((r) => r.status);
  check("RPC text/plain rejected (415)", (await post({ "content-type": "text/plain" })) === 415);
  check("RPC missing x-nowaki-rpc rejected (403)",
    (await post({ "content-type": "application/json" })) === 403);
  check("RPC cross-origin rejected (403)",
    (await post({ "content-type": "application/json", "x-nowaki-rpc": "1", origin: "http://evil.test" })) === 403);
  await forwardedHostIgnored(base);
  await serverFnHardening(base, mode);
  await crossSiteWritesRejected(base);
  await securityHeadersPresent(base, ["/", "/nope"]);

  // CSWSH (Origin check on WS upgrade)
  check("CSWSH /__nowaki/live cross-origin upgrade rejected (403)",
    (await wsUpgrade(base, "/__nowaki/live", "http://evil.test")) === 403);
  check("WS same-origin upgrade allowed (101)",
    (await wsUpgrade(base, "/__nowaki/live", base)) === 101);

  // forged live state
  check("forged live join is rejected (no patch)", await liveForgeryRejected(base));
  // The sidecar's internal re-render endpoint trusts its body (state, request context); the public
  // server must never proxy it.
  check("internal /__nowaki/live-render is not reachable (404)",
    (await fetch(`${base}/__nowaki/live-render`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "LiveCounter", state: {}, sig: "", handler: "adminReset", request: { headers: { cookie: "role=admin" } } }) })).status === 404);
  await liveEventGate(base);
}

if (mode === "prod") {
  // 500s never carry a stack trace (file paths, code) in production — neither the app's _500 page
  // nor the built-in fallback used when _500 itself throws.
  const stackLike = /\n\s+at |\(file:\/\/|node:internal/;
  const err500 = await fetch(`${base}/boom?boom=1`);
  check("prod _500 page has no stack trace", err500.status === 500 && !stackLike.test(await err500.text()));
  const nested = await fetch(`${base}/boom?boom=nested`);
  const nestedBody = await nested.text();
  check(`prod fallback 500 is generic (${JSON.stringify(nestedBody.slice(0, 40))})`,
    nested.status === 500 && nestedBody === "Internal Server Error");
  // ISR cross-user isolation (accept-language-dependent route /vary)
  const get = (lang) =>
    fetch(`${base}/vary`, { headers: { "accept-language": lang } });
  await get("de-DE"); // first request: learns and stores the de variant
  const en = await get("en-US");
  const enBody = await en.text();
  const de2 = await get("de-DE");
  check("ISR isolates per accept-language (en is not served de's cache)",
    enBody.includes("en-US") && !enBody.includes("de-DE"));
  check("ISR variant is cached on repeat (HIT/STALE)",
    /HIT|STALE/.test(de2.headers.get("x-nowaki-cache") || ""));

  // ISR query-flood collapsing (/isr doesn't read the query -> ?cb collapses into one entry)
  await fetch(`${base}/isr`); // populate
  const f1 = (await fetch(`${base}/isr?cb=1`)).headers.get("x-nowaki-cache");
  const f2 = (await fetch(`${base}/isr?cb=2`)).headers.get("x-nowaki-cache");
  check("ISR query-flood collapses (distinct ?cb served from one entry)",
    /HIT|STALE/.test(f1 || "") && /HIT|STALE/.test(f2 || ""));

  // Prod static assets: /_nowaki/* resolves by basename under dist/client only (start.rs serve_static).
  const home = await (await fetch(`${base}/`)).text();
  const hashed = home.match(/\/_nowaki\/([A-Za-z0-9_.-]+\.js)/)?.[1];
  check("home page references a /_nowaki/*.js asset", Boolean(hashed));
  if (hashed) {
    check("legit /_nowaki client asset (200)", (await statusOf(`${base}/_nowaki/${hashed}`)) === 200);
  }
  // /isr twice: the second response is an ISR HIT/STALE served from the Rust cache.
  await securityHeadersPresent(base, ["/", "/nope", "/isr", "/isr", ...(hashed ? [`/_nowaki/${hashed}`] : [])]);
  for (const p of [
    "/_nowaki/../../../etc/passwd",
    "/_nowaki/foo/../../../../etc/passwd",
    "/_nowaki/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    "/_nowaki/../../server/functions.json",
    // Windows path syntax must not escape dist/client either (backslashes, drive letters).
    "/_nowaki/..\\..\\package.json",
    "/_nowaki/C:\\Windows\\win.ini",
  ]) {
    const st = await rawGet(base, p);
    check(`/_nowaki traversal blocked (${p} → ${st})`, st === 404);
  }
}

console.log(fails ? `\nSECURITY-E2E FAILED (${fails})` : "\nSECURITY-E2E PASSED");
await sleep(50);
process.exit(fails ? 1 : 0);
