// The Cloudflare Worker's ISR cache and purge (server/purge-cloudflare.mjs, wired by web.mjs
// `createFetchHandler`), with a mocked `caches.default` and a mocked fetch for the zone purge API:
// MISS → HIT, stale-while-revalidate through ctx.waitUntil, Vary / query variants, never storing
// per-user pages (cookies, session, authorization, Set-Cookie, streamed), revalidatePath deleting
// the local entries, the zone purge by tag (URL, token, body, batches), the 2 s cap, the warnings,
// a fresh CSP nonce per cache hit, and that the worker's imports never name @vercel/functions.
// No network, no port. Usage: node scripts/cf-cache-test.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFetchHandler } from "../packages/nowaki-runtime/server/web.mjs";
import { CF_TAG_HEADER, cfTag, cloudflareCdn, shareable } from "../packages/nowaki-runtime/server/purge-cloudflare.mjs";
import * as R from "../packages/nowaki-runtime/server/revalidate.mjs";
import { nonce as cspNonce } from "../packages/nowaki-runtime/server/nonce.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { h } = createRequire(path.join(root, "packages/nowaki-runtime/server/handler.mjs"))("preact");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failures++;
};
const warnings = [];
console.warn = (...a) => warnings.push(a.join(" "));
const warned = (re) => warnings.filter((w) => re.test(w)).length;

// --- a Cache API stand-in with Cloudflare's documented put rules ------------------------------------
function mockCache() {
  const store = new Map();
  const log = [];
  const keyOf = (r) => (typeof r === "string" ? r : r.url);
  return {
    store,
    log,
    async match(r) {
      const k = keyOf(r);
      log.push(`match ${k}`);
      const e = store.get(k);
      return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
    },
    async put(r, res) {
      if (typeof r !== "string" && r.method !== "GET") throw new TypeError("put: non-GET key");
      if (res.status === 206) throw new TypeError("put: 206");
      if ((res.headers.get("vary") ?? "").trim() === "*") throw new TypeError("put: Vary *");
      if (res.headers.has("set-cookie")) return; // never cached
      if (/\b(private|no-store|no-cache)\b/.test(res.headers.get("cache-control") ?? "")) throw new Error("413");
      const k = keyOf(r);
      const tags = (res.headers.get("cache-tag") ?? "").split(",").filter(Boolean).map((t) => t.toLowerCase());
      // The stored headers keep Cache-Tag, as local workerd (wrangler dev) does; production strips it.
      store.set(k, { status: res.status, headers: [...res.headers], body: await res.text(), tags, cc: res.headers.get("cache-control") });
      log.push(`put ${k}`);
    },
    async delete(r) {
      log.push(`delete ${keyOf(r)}`);
      return store.delete(keyOf(r));
    },
    // What a zone purge by tag does to this colo.
    purgeTags(tags) {
      const want = new Set(tags.map((t) => t.toLowerCase()));
      for (const [k, e] of store) if (e.tags.some((t) => want.has(t))) store.delete(k);
    },
  };
}

const cache = mockCache();
globalThis.caches = { default: cache };
let clock = 1_000_000;
const zoneCalls = [];
let zoneImpl = async (url, init) => {
  zoneCalls.push({ url, init, body: JSON.parse(init.body) });
  cache.purgeTags(JSON.parse(init.body).tags);
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { id: "x" } }), { headers: { "content-type": "application/json" } });
};

let renders = {};
const bump = (k) => (renders[k] = (renders[k] ?? 0) + 1);
let gate = null;
const page = (name, extra = {}) => ({
  revalidate: 2,
  loader: async (ctx) => {
    if (name === "slow" && gate) await gate;
    return { n: bump(name), ...(extra.read ? extra.read(ctx) : {}) };
  },
  default: ({ data }) => h("p", null, `${name} #${data.n}${data.v !== undefined ? ` v=${data.v}` : ""}`),
  ...extra.mod,
});
const modules = {
  "routes/isr.tsx": page("isr", { mod: { tags: ["posts"] } }),
  "routes/lang.tsx": page("lang", { read: (ctx) => ({ v: ctx.get("accept-language") ?? "none" }) }),
  "routes/q.tsx": page("q", { read: (ctx) => ({ v: ctx.url.searchParams.get("a") }) }),
  "routes/cookie.tsx": page("cookie", { read: (ctx) => ({ v: ctx.cookies.user ?? "guest" }) }),
  "routes/session.tsx": page("session", { read: (ctx) => ({ v: ctx.session.get("user") ?? "anon" }) }),
  "routes/auth.tsx": page("auth", { read: (ctx) => ({ v: ctx.get("authorization") ?? "none" }) }),
  "routes/raw.tsx": page("raw", { read: (ctx) => ({ v: ctx.headers["x-user"] ?? "none" }) }),
  "routes/sets.tsx": page("sets", { read: (ctx) => (ctx.setCookie("visited", "1", { path: "/" }), {}) }),
  "routes/stream.tsx": page("stream", { mod: { streaming: true } }),
  "routes/early.tsx": page("early", { mod: { streaming: "early" } }),
  "routes/slow.tsx": page("slow"),
  "routes/plain.tsx": { loader: async () => ({ n: bump("plain") }), default: ({ data }) => h("p", null, `plain #${data.n}`) },
  "routes/save.tsx": {
    action: async (ctx) => {
      const f = await ctx.formData();
      if (f.get("path")) R.revalidatePath(String(f.get("path")));
      if (f.get("tag")) R.revalidateTag(String(f.get("tag")));
      return ctx.redirect("/isr", 303);
    },
    default: () => h("p", null, "form"),
  },
};
const routeTable = {
  routes: Object.keys(modules).map((file) => ({ file, segments: [{ lit: file.slice(7, -4) }], dir: "", isApi: false, fileExt: ".tsx", specificity: 1 })),
  layouts: [],
  middleware: [],
  loadingBoundaries: [],
  errorBoundaries: [],
  slots: [],
  notFound: null,
  errorRoute: null,
};
const handler = createFetchHandler({
  manifest: { islands: {} },
  modules,
  islandComponents: {},
  liveIslands: {},
  routeTable,
  serverFunctions: {},
  cdn: { now: () => clock, fetch: (...a) => zoneImpl(...a), timeoutMs: 150 },
});

const ORIGIN = "https://app.example";
let bindings = {};
let waits = [];
const exec = { waitUntil: (p) => waits.push(p) };
const flush = async () => {
  while (waits.length) {
    const w = waits;
    waits = [];
    await Promise.all(w);
  }
};
const get = async (p, headers = {}, method = "GET") => {
  const res = await handler(new Request(ORIGIN + p, { method, headers }), bindings, undefined, exec);
  return { res, text: await res.text(), status: res.headers.get("x-nowaki-cache") };
};
const post = (p, body, origin = ORIGIN) =>
  handler(new Request(origin + p, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body }), bindings, undefined, exec);
const INTERNAL = ["x-nowaki-revalidate", "x-nowaki-vary", "x-nowaki-vary-query", "x-nowaki-tags", "cache-tag", "x-nowaki-stored", "x-nowaki-cc", "x-nowaki-stub", "x-nowaki-vary-out"];
const clean = (res) => INTERNAL.every((n) => !res.headers.has(n));

// --- MISS → HIT ----------------------------------------------------------------------------------
{
  const a = await get("/isr");
  check("first request renders: MISS", a.status === "MISS" && a.text.includes("isr #1"), `${a.status} ${a.text}`);
  check("a MISS sends no internal header (x-nowaki-*, Cache-Tag)", clean(a.res), JSON.stringify([...a.res.headers]));
  check("the browser still gets the shared Cache-Control", /public, s-maxage=2/.test(a.res.headers.get("cache-control") ?? ""));
  await flush();
  const e = cache.store.get(`${ORIGIN}/isr`);
  check("stored under the page URL, with the page's tags as Cache-Tag", e && e.tags.join(",") === "t:posts,p:/isr", JSON.stringify(e?.tags));
  check("stored with a long max-age (staleness is decided by the worker)", e && /max-age=31536000/.test(e.cc));
  const b = await get("/isr");
  check("second request: HIT, no render", b.status === "HIT" && b.text.includes("isr #1") && renders.isr === 1, `${b.status} ${b.text}`);
  check("a HIT sends no internal header and restores Cache-Control", clean(b.res) && /public, s-maxage=2/.test(b.res.headers.get("cache-control") ?? ""), JSON.stringify([...b.res.headers]));
  check("a HIT has the security headers", b.res.headers.get("x-content-type-options") === "nosniff");
  const q = await get("/isr?utm=1");
  check("a query the page doesn't read hits the same entry", q.status === "HIT" && renders.isr === 1);
  const hd = await get("/isr", {}, "HEAD");
  check("HEAD is answered from the entry, without a body", hd.status === "HIT" && hd.text === "");
  const ic = await get("/isr", { "x-nowaki-intercept": "/x/@modal" });
  check("an intercept fragment request bypasses the cache", ic.status === null && renders.isr === 2);
}

// --- stale-while-revalidate ------------------------------------------------------------------------
{
  clock += 2500;
  const before = renders.isr;
  const [s1, s2] = await Promise.all([get("/isr"), get("/isr")]);
  check("after revalidate seconds: STALE, old body served", s1.status === "STALE" && s1.text.includes(`isr #1`), `${s1.status} ${s1.text}`);
  check("...without waiting for the render", s2.status === "STALE");
  await flush();
  check("one background render for both (single-flight, via waitUntil)", renders.isr === before + 1, `${renders.isr - before}`);
  const fresh = await get("/isr");
  check("the background render replaced the entry: HIT with the new body", fresh.status === "HIT" && fresh.text.includes(`isr #${before + 1}`), fresh.text);
  clock += 2500;
  const noCtx = await handler(new Request(`${ORIGIN}/isr`), bindings);
  const noCtxText = await noCtx.text();
  check("without an execution context a stale entry renders in the request (MISS)", noCtx.headers.get("x-nowaki-cache") === "MISS" && noCtxText.includes(`isr #${before + 2}`), `${noCtx.headers.get("x-nowaki-cache")} ${noCtxText}`);
  await new Promise((r) => setTimeout(r, 10));
}

// --- variants: Vary headers and the query -----------------------------------------------------------
{
  const de = await get("/lang", { "accept-language": "de" });
  await flush();
  const en = await get("/lang", { "accept-language": "en" });
  await flush();
  const de2 = await get("/lang", { "accept-language": "de" });
  const en2 = await get("/lang", { "accept-language": "en" });
  const none = await get("/lang");
  check("accept-language variants are kept apart", de.text.includes("v=de") && en.status === "MISS" && en.text.includes("v=en"), `${en.status} ${en.text}`);
  check("...and each hits its own entry", de2.status === "HIT" && de2.text.includes("v=de") && en2.status === "HIT" && en2.text.includes("v=en"));
  check("an absent header is its own variant", none.status === "MISS" && none.text.includes("v=none"));
  check("the response keeps Vary: accept-language", /accept-language/i.test(en2.res.headers.get("vary") ?? ""));
  const stub = cache.store.get(`${ORIGIN}/lang`);
  check("the page URL holds the stub naming the varied header", stub && stub.headers.some(([k, v]) => k === "x-nowaki-vary" && v === "accept-language"));
  await flush();
  const a1 = await get("/q?a=1");
  await flush();
  const a2 = await get("/q?a=2");
  await flush();
  const a1b = await get("/q?a=1");
  check("a page reading the query is cached per query", a1.text.includes("v=1") && a2.status === "MISS" && a2.text.includes("v=2") && a1b.status === "HIT" && a1b.text.includes("v=1"));
}

// --- never shared: per-user pages ------------------------------------------------------------------
{
  const keys = () => [...cache.store.keys()].filter((k) => /\/(cookie|session|auth|raw|sets|stream|early)\b/.test(k));
  const alice = await get("/cookie", { cookie: "user=alice" });
  await flush();
  const bob = await get("/cookie", { cookie: "user=bob" });
  check("a page reading a cookie is private and never stored", /private/.test(alice.res.headers.get("cache-control") ?? "") && alice.status === null && bob.text.includes("v=bob"));
  process.env.NOWAKI_SESSION_SECRET = "cf-cache-test-session-secret-0123456789";
  const s = await get("/session", { cookie: "x=1" });
  await flush();
  check("a page reading the session is private and never stored", s.res.status === 200 && /private/.test(s.res.headers.get("cache-control") ?? "") && s.status === null, `${s.res.status} ${s.res.headers.get("cache-control")}`);
  const au = await get("/auth", { authorization: "Bearer a" });
  await flush();
  const au2 = await get("/auth", { authorization: "Bearer b" });
  check("a page reading authorization is never stored", au.status === null && au2.text.includes("v=Bearer b"));
  const raw = await get("/raw", { "x-user": "u1" });
  await flush();
  check("a page reading the raw headers (Vary *) is never stored", raw.status === null && /private/.test(raw.res.headers.get("cache-control") ?? ""));
  const set1 = await get("/sets");
  await flush();
  const set2 = await get("/sets");
  check("a page that sets a cookie is never stored (and the cookie still goes out)", set1.status === null && set2.text.includes("sets #2") && /visited=1/.test(set2.res.headers.get("set-cookie") ?? ""));
  const st = await get("/stream");
  await flush();
  check("a streamed page is not stored (as under nowaki start), and its Cache-Tag stays internal", st.status === null && st.text.includes("stream #1") && !st.res.headers.has(CF_TAG_HEADER));
  const ea = await get("/early");
  await flush();
  check("an early-streamed page is not stored", ea.status === null && ea.text.includes("early #1"));
  check("none of them left an entry", keys().length === 0, JSON.stringify(keys()));
  check("shareable() refuses a per-user Vary even with a public Cache-Control", shareable({ status: 200, body: "x", headers: { "x-nowaki-revalidate": "5", "x-nowaki-vary": "cookie", "cache-control": "public, s-maxage=5" } }) === null);
  check("shareable() refuses Set-Cookie", shareable({ status: 200, body: "x", headers: { "x-nowaki-revalidate": "5", "set-cookie": "a=1", "cache-control": "public, s-maxage=5" } }) === null);
  check("shareable() refuses a non-200", shareable({ status: 404, body: "x", headers: { "x-nowaki-revalidate": "5", "cache-control": "public, s-maxage=5" } }) === null);
}

// --- non-ISR paths -----------------------------------------------------------------------------------
{
  await get("/plain");
  cache.log.length = 0;
  const p = await get("/plain");
  check("a path that rendered no ISR page skips the lookup afterwards (no cache call)", p.text.includes("plain #2") && cache.log.length === 0, JSON.stringify(cache.log));
  const nf = await get("/nope");
  check("a 404 is not stored", nf.res.status === 404 && !cache.store.has(`${ORIGIN}/nope`));
}

// --- revalidatePath: local delete ----------------------------------------------------------------------
{
  await get("/isr");
  await flush();
  check("(the page is cached)", cache.store.has(`${ORIGIN}/isr`));
  const res = await post("/save", "path=/isr");
  check("the action redirects", res.status === 303);
  check("revalidatePath deleted the page from the local cache before the response", !cache.store.has(`${ORIGIN}/isr`));
  check("...both trailing-slash forms", cache.log.includes(`delete ${ORIGIN}/isr`) && cache.log.includes(`delete ${ORIGIN}/isr/`));
  check("without zone credentials it warns once", warned(/CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are not set/) === 1);
  await post("/save", "path=/isr");
  check("...only once", warned(/CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are not set/) === 1);
  const after = await get("/isr");
  check("the next request renders fresh (MISS)", after.status === "MISS");
  await flush();
  await get("/lang", { "accept-language": "de" });
  await flush();
  await post("/save", "path=/lang");
  const lang = await get("/lang", { "accept-language": "de" });
  check("revalidatePath drops every variant (the stub's generation is gone)", lang.status === "MISS", lang.status);
  await flush();
  check("no zone call without credentials", zoneCalls.length === 0);
}

// --- a render that started before a purge doesn't store --------------------------------------------
{
  let open;
  gate = new Promise((r) => (open = r));
  const pending = get("/slow");
  await new Promise((r) => setTimeout(r, 10));
  await post("/save", "path=/slow");
  open();
  const r = await pending;
  await flush();
  gate = null;
  check("a render that raced a purge is served but not stored", r.text.includes("slow #1") && !cache.store.has(`${ORIGIN}/slow`));
}

// --- zone purge by tag ------------------------------------------------------------------------------
{
  bindings = { CLOUDFLARE_ZONE_ID: "zone123", CLOUDFLARE_API_TOKEN: "tok-abc" };
  await get("/isr");
  await flush();
  check("(the tagged page is cached)", cache.store.has(`${ORIGIN}/isr`));
  const res = await post("/save", "tag=posts");
  const call = zoneCalls[0];
  check("revalidateTag calls the zone purge API", res.status === 303 && zoneCalls.length === 1);
  check("...POST to /zones/<id>/purge_cache", call?.url === "https://api.cloudflare.com/client/v4/zones/zone123/purge_cache" && call?.init.method === "POST", call?.url);
  check("...with the API token as a Bearer and a JSON body", call?.init.headers.authorization === "Bearer tok-abc" && call?.init.headers["content-type"] === "application/json");
  check("...purging the tag the pages carry", JSON.stringify(call?.body) === JSON.stringify({ tags: ["t:posts"] }), JSON.stringify(call?.body));
  check("the tagged page is gone (purged by tag)", !cache.store.has(`${ORIGIN}/isr`));
  zoneCalls.length = 0;
  await post("/save", "path=/isr");
  check("revalidatePath purges the path tags globally too", JSON.stringify(zoneCalls[0]?.body) === JSON.stringify({ tags: ["p:/isr", "p:/isr/"] }), JSON.stringify(zoneCalls[0]?.body));
  zoneCalls.length = 0;

  // An API error warns once per error code.
  zoneImpl = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1134, message: "Unable to purge, rate limit reached" }] }), { status: 429 });
  await post("/save", "tag=posts");
  await post("/save", "tag=posts");
  check("a rejected purge (rate limit) warns once", warned(/zone purge failed \(1134: Unable to purge, rate limit reached\)/) === 1);

  // 2 s cap (150 ms here): the response doesn't wait for a hanging purge, which continues in waitUntil.
  let finish;
  zoneImpl = () => new Promise((r) => (finish = () => r(new Response('{"success":true}'))));
  const t0 = Date.now();
  const slow = await post("/save", "tag=posts");
  const took = Date.now() - t0;
  check("a hanging zone purge holds the response for the cap only", slow.status === 303 && took >= 140 && took < 1500, `${took} ms`);
  check("...warns that it didn't finish", warned(/did not finish within 150 ms/) === 1);
  check("...and the rest of the purge goes into ctx.waitUntil", waits.length > 0);
  finish();
  await flush();
}

// --- cloudflareCdn directly: batching, workers.dev, tags --------------------------------------------
{
  const calls = [];
  const cdn = cloudflareCdn({
    caches: () => null,
    credentials: () => ({ zone: "z", token: "t" }),
    fetch: async (url, init) => (calls.push(JSON.parse(init.body).tags), new Response('{"success":true}')),
  });
  const many = Array.from({ length: 150 }, (_, i) => `t:tag${i}`);
  await cdn.purge([...many, "t:TAG0"]);
  check("tags go out in batches of 100", calls.length === 2 && calls[0].length === 100 && calls[1].length === 50, JSON.stringify(calls.map((c) => c.length)));
  check("tags differing only in case are sent once (Cloudflare tags are case-insensitive)", !calls.flat().includes("t:TAG0"));
  const dev = cloudflareCdn({ caches: () => null });
  await dev.purge(["p:/x"], { url: new URL("https://my-app.acct.workers.dev/x") });
  check("on workers.dev: warns that there is no zone purge", warned(/workers\.dev: there is no zone to purge/) === 1);

  const VISIBLE = /^[\x21-\x2b\x2d-\x7e]+$/;
  const samples = ["t:posts", 'p:/a"b c', `p:/${"\u00e9".repeat(200)}`, `t:${"x".repeat(256)}`, "t:\u{1F600}"].map(cfTag);
  check("every tag is printable ASCII without comma or space, at most 240 characters", samples.every((t) => VISIBLE.test(t) && t.length <= 240), JSON.stringify(samples));
  const header = dev.cacheTagHeader([...Array.from({ length: 64 }, (_, i) => `t:${"\u00e9".repeat(120)}${i}`), `p:/${"x".repeat(2000)}`])[CF_TAG_HEADER];
  check("65 maximal tags stay under Cloudflare's 16 KB Cache-Tag header", header.length < 16 * 1024, `${header.length}`);
  check("cacheTagHeader of nothing is null", dev.cacheTagHeader([]) === null);
}

// --- CSP: a cached page gets a fresh nonce per response, on its nonce() tag only ---------------
{
  bindings = {};
  zoneImpl = async () => new Response('{"success":true}');
  // The page's own nonce() style, and a raw one (as if from content): the cache keeps the render's
  // marker, and each hit turns it into that response's nonce.
  modules["routes/isr.tsx"].meta = () => ({ head: `<style id="own" nonce="${cspNonce()}">.x{}</style><style id="raw">.y{}</style>` });
  process.env.NOWAKI_CSP = "enforce";
  await get("/isr");
  await flush();
  const a = await get("/isr");
  const b = await get("/isr");
  const nonce = (r) => /'nonce-([0-9a-f]{32})'/.exec(r.res.headers.get("content-security-policy") ?? "")?.[1];
  check("NOWAKI_CSP: two HITs carry different nonces, each in its own body", a.status === "HIT" && b.status === "HIT" && nonce(a) && nonce(a) !== nonce(b) && a.text.includes(`<style id="own" nonce="${nonce(a)}">`) && b.text.includes(`<style id="own" nonce="${nonce(b)}">`));
  check("NOWAKI_CSP: a raw <style> gets no nonce, and no marker reaches the response", [a, b].every((r) => r.text.includes('<style id="raw">') && (r.text.match(/nonce="/g) ?? []).length === 1 && !r.res.headers.has("x-nowaki-csp-marker")));
  delete process.env.NOWAKI_CSP;
}

// --- an app without ISR pages: nothing changes ----------------------------------------------------
{
  const quiet = mockCache();
  globalThis.caches = { default: quiet };
  const plainOnly = { "routes/plain.tsx": modules["routes/plain.tsx"] };
  const h2 = createFetchHandler({
    manifest: { islands: {} },
    modules: plainOnly,
    routeTable: { ...routeTable, routes: routeTable.routes.filter((r) => r.file === "routes/plain.tsx") },
  });
  const r = await h2(new Request(`${ORIGIN}/plain`), {}, undefined, exec);
  check("no ISR page: no cache call and no x-nowaki-cache", r.status === 200 && quiet.log.length === 0 && !r.headers.has("x-nowaki-cache"));
}

// --- the Worker bundle can't pull in @vercel/functions ----------------------------------------------
// wrangler's bundler resolves every import(), even a lazy one: a module of web.mjs's graph naming
// the package fails the deploy. Walks the relative imports from web.mjs.
{
  const { readFileSync } = await import("node:fs");
  const seen = new Set();
  const offenders = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    if (src.includes('"@vercel/functions"')) offenders.push(path.basename(file));
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*"(\.\.?\/[^"]+\.mjs)"/g)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(root, "packages/nowaki-runtime/server/web.mjs"));
  check("no module the worker imports names @vercel/functions", offenders.length === 0 && seen.has(path.join(root, "packages/nowaki-runtime/server/purge-cloudflare.mjs")), offenders.join(", "));
}

console.log(failures ? `\nCF CACHE TEST FAILED (${failures})` : "\nCF CACHE TEST PASSED");
process.exit(failures ? 1 : 0);
