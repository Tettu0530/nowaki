// examples/gallery end to end: the v0.18 exit-criteria app (basePath "/gallery", i18n en/ja with
// detection, a modal gallery through an intercepting route, a session behind a route group's
// middleware, config redirects / headers, env.ts) over HTTP on each server, and the v0.19 one: a
// signed-in caption edit on a cached (ISR, tagged) post calls revalidateTag, and the next GET is
// fresh on `nowaki start`, on the Cloudflare worker's cache and behind Vercel's CDN, while the
// other posts stay cached; one request is one OpenTelemetry trace. Builds the example in place.
//   node scripts/gallery-e2e.mjs <mode>... [--port 5130]
// Modes: start (`nowaki start`), dev (`nowaki dev`), node (node adapter), cloudflare (the worker's
// fetch, called in Node, then with a stand-in for caches.default and the zone purge API), vercel
// (the generated function with a fake @vercel/functions, behind a stand-in for Vercel's CDN that
// caches by s-maxage and deletes by Vercel-Cache-Tag), static (prerender output: what a static
// host can serve; the session pages make the full app refuse it), env (a missing or invalid
// variable stops `nowaki build` and `nowaki start`, named, its value never printed), otel
// (`nowaki start` exporting to a local OTLP receiver on port+1: route, middleware, loader and
// render of one request in one trace). NOWAKI_BIN overrides the binary (default
// target/debug/nowaki). The browser half is scripts/gallery-browser-test.mjs.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "examples/gallery");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 5130;
const modes = args.filter((a, i) => !a.startsWith("--") && (portArg < 0 || i !== portArg + 1));
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const KNOWN = ["start", "dev", "node", "cloudflare", "vercel", "static", "env", "otel"];
if (!modes.length || modes.some((m) => !KNOWN.includes(m))) {
  console.error(`usage: node scripts/gallery-e2e.mjs <${KNOWN.join("|")}>... [--port 5130]`);
  process.exit(2);
}

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The variables env.ts declares, with values the checks look for in the output.
const PASSWORD = "gallery-e2e-password-7d1f";
const SECRET = "gallery-e2e-session-secret-0123456789abcdef";
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALLERY_") && k !== "NOWAKI_SESSION_SECRET" && !k.startsWith("PUBLIC_GALLERY")));
const ENV = { ...baseEnv, GALLERY_ADMIN_PASSWORD: PASSWORD, NOWAKI_SESSION_SECRET: SECRET };

// Japanese strings the app renders (\u escapes: the repo is English-only).
const JA = { gallery: "\u30AE\u30E3\u30E9\u30EA\u30FC", dune: "\u7802\u4E18", wrong: "\u30D1\u30B9\u30EF\u30FC\u30C9\u304C\u9055\u3044\u307E\u3059", signedIn: "\u30ED\u30B0\u30A4\u30F3\u4E2D" };
const SITE = "https://gallery.nowaki.dev";

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-gallery-e2e-"));
const children = new Set();
const cleanup = () => {
  for (const c of children) c.kill("SIGKILL");
  try {
    // Windows can still hold files of a just-killed child (EBUSY); a leftover temp dir isn't a failure.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const output = (r) => `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
function nowaki(argv, env = ENV, timeout = 300_000) {
  return spawnSync(BIN, argv, { env, encoding: "utf8", timeout });
}
function build(dir, adapter) {
  const r = nowaki(["build", dir, ...(adapter ? ["--adapter", adapter] : [])]);
  if (r.status !== 0) {
    console.error(output(r));
    throw new Error(`nowaki build ${adapter ?? ""} failed`);
  }
  return output(r);
}

async function serve(cmd, argv, env, port) {
  const child = spawn(cmd, argv, { stdio: ["pipe", "inherit", "inherit"], env });
  children.add(child);
  for (let i = 0; i < 160; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/gallery/__nowaki/boundaries" }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return () => (child.kill(), children.delete(child));
    await sleep(250);
  }
  throw new Error(`${cmd} ${argv.join(" ")} did not listen on ${port}`);
}

const httpClient = (port) => (p, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
    req.end(body);
  });

// The Cloudflare worker's fetch, called in Node, with an ASSETS binding serving dist/worker/assets
// and the variables as Worker bindings. With `cache`, also a stand-in for caches.default (honoring
// the Cache-Tag the worker stores) and for the zone purge API in fetch (which deletes the entries
// carrying a purged tag, as Cloudflare does), and an execution context whose waitUntil work
// `flush()` awaits.
async function workerClient(dir, { cache = false } = {}) {
  const workerDir = path.join(dir, "dist/worker");
  const worker = (await import(pathToFileURL(path.join(workerDir, "index.js")).href)).default;
  const ASSETS = {
    fetch: async (request) => {
      const file = path.join(workerDir, "assets", decodeURIComponent(new URL(request.url).pathname));
      return existsSync(file) && statSync(file).isFile() ? new Response(readFileSync(file)) : new Response("missing", { status: 404 });
    },
  };
  const bindings = { ASSETS, GALLERY_ADMIN_PASSWORD: PASSWORD, NOWAKI_SESSION_SECRET: SECRET };
  const waits = [];
  const exec = cache ? { waitUntil: (p) => waits.push(p) } : undefined;
  const zonePurges = [];
  if (cache) {
    const store = new Map();
    globalThis.caches = {
      default: {
        match: async (k) => {
          const e = store.get(String(k));
          return e ? new Response(e.body, { headers: e.headers }) : undefined;
        },
        put: async (k, res) => {
          const tags = (res.headers.get("cache-tag") ?? "").split(",").filter(Boolean);
          store.set(String(k), { body: await res.text(), headers: [...res.headers].filter(([n]) => n !== "cache-tag"), tags });
        },
        delete: async (k) => store.delete(String(k)),
      },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.cloudflare.com/")) return realFetch(url, init);
      const { tags } = JSON.parse(init.body);
      zonePurges.push({ url: String(url), tags });
      for (const [k, e] of store) if (e.tags.some((t) => tags.some((x) => x.toLowerCase() === t.toLowerCase()))) store.delete(k);
      return new Response('{"success":true}');
    };
    bindings.CLOUDFLARE_ZONE_ID = "gallery-zone";
    bindings.CLOUDFLARE_API_TOKEN = "gallery-token";
  }
  const req = async (p, { method = "GET", headers = {}, body } = {}) => {
    const res = await worker.fetch(new Request(`https://app.example${p}`, { method, headers, body, redirect: "manual" }), bindings, exec);
    const out = Object.fromEntries(res.headers);
    if (res.headers.getSetCookie().length) out["set-cookie"] = res.headers.getSetCookie();
    return { status: res.status, headers: out, body: await res.text() };
  };
  req.flush = () => Promise.all(waits.splice(0));
  req.zonePurges = zonePurges;
  return req;
}

// The function `nowaki build --adapter vercel` generates, served on `port`, behind a stand-in for
// Vercel's CDN: a GET whose response has `s-maxage` (and no Set-Cookie) is kept per path with the
// tags of its Vercel-Cache-Tag, answered from there (`x-vercel-cache: HIT`) until the fake
// @vercel/functions' dangerouslyDeleteByTag drops the entries carrying one of the tags. The app is
// a copy with that package in node_modules, which vercel-build.mjs copies into the function.
async function vercelClient(port) {
  const dir = path.join(tmp, "vercel");
  const skip = new Set(["node_modules", "dist", ".nowaki", ".vercel"]);
  cpSync(APP, dir, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  linkModules(path.join(APP, "node_modules"), path.join(dir, "node_modules"));
  const fake = path.join(dir, "node_modules/@vercel/functions");
  mkdirSync(fake, { recursive: true });
  writeFileSync(path.join(fake, "package.json"), JSON.stringify({ name: "@vercel/functions", version: "3.11.1", main: "index.js" }));
  writeFileSync(path.join(fake, "index.js"), "exports.dangerouslyDeleteByTag = async (tags) => { globalThis.__galleryCdnDelete(tags); };\n");
  const log = build(dir, "vercel");
  check("vercel: the build includes @vercel/functions (purges on)", /@vercel\/functions included/.test(log), log.slice(-800));

  const store = new Map();
  const deletes = [];
  globalThis.__galleryCdnDelete = (tags) => {
    deletes.push(tags);
    for (const [k, e] of store) if (e.tags.some((t) => tags.includes(t))) store.delete(k);
  };
  // The function reads its variables from process.env; VERCEL=1 is what Vercel sets.
  Object.assign(process.env, { GALLERY_ADMIN_PASSWORD: PASSWORD, NOWAKI_SESSION_SECRET: SECRET, VERCEL: "1" });
  const func = path.join(dir, ".vercel/output/functions/index.func/index.mjs");
  const { default: handle } = await import(pathToFileURL(func).href);
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const origin = httpClient(port);
  const req = async (p, opts = {}) => {
    const get = (opts.method ?? "GET") === "GET";
    const key = p.split("?")[0];
    if (get && store.has(key)) {
      const e = store.get(key);
      return { status: e.status, headers: { ...e.headers, "x-vercel-cache": "HIT" }, body: e.body };
    }
    const r = await origin(p, opts);
    const cc = String(r.headers["cache-control"] ?? "");
    if (get && r.status === 200 && /\bs-maxage=\d+/.test(cc) && !/\bprivate\b/.test(cc) && !r.headers["set-cookie"]) {
      const tags = String(r.headers["vercel-cache-tag"] ?? "").split(",").filter(Boolean);
      store.set(key, { status: r.status, headers: r.headers, body: r.body, tags });
      return { ...r, headers: { ...r.headers, "x-vercel-cache": "MISS" } };
    }
    return r;
  };
  req.deletes = deletes;
  req.close = () => new Promise((r) => server.close(r));
  return req;
}

const cookieOf = (r) => [r.headers["set-cookie"] ?? []].flat().find((c) => c.startsWith("gallery_session=")) ?? "";
const form = (origin, body, cookie) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin, ...(cookie ? { cookie } : {}) },
  body,
});

async function checks(label, req, origin, { dev = false } = {}) {
  const t = (s) => `${label}: ${s}`;
  const varies = (r) => /accept-language/i.test(r.headers.vary ?? "") && /cookie/i.test(r.headers.vary ?? "");

  // Two locales under the base.
  let r = await req("/gallery");
  check(t("/gallery is the English gallery"), r.status === 200 && /<html lang="en"/.test(r.body) && r.body.includes('<h1 id="gallery">Gallery</h1>'), `${r.status} ${r.body.slice(0, 300)}`);
  check(t("/gallery varies on Accept-Language and Cookie (detection)"), varies(r), r.headers.vary);
  check(
    t("hreflang alternates carry the base"),
    r.body.includes(`<link rel="alternate" hreflang="en" href="${SITE}/gallery" />`) &&
      r.body.includes(`<link rel="alternate" hreflang="ja" href="${SITE}/gallery/ja" />`) &&
      r.body.includes(`<link rel="alternate" hreflang="x-default" href="${SITE}/gallery" />`),
    r.body.slice(0, 1500),
  );
  check(t("thumbnails link under the base"), r.body.includes('id="photo-1" href="/gallery/photo/1"'), r.body.slice(0, 1500));
  const img = (r.body.match(/<img src="([^"]+)"/)?.[1] ?? "").replaceAll("&amp;", "&");
  // (dev serves its own asset URLs at the root: /__nowaki/image, /__nowaki/css)
  const imgUrl = dev ? /^\/__nowaki\/image\?f=\/photos\/dune\.png&/ : /^\/gallery\/_nowaki\/dune-\d+\.[0-9a-f]+\.png$/;
  check(t("images come from the image pipeline under the base"), imgUrl.test(img) && r.body.includes('type="image/avif"'), img);
  const asset = await req(img || "/gallery/_nowaki/missing.png");
  check(t("the image is served"), asset.status === 200, `${img} ${asset.status}`);
  if (!dev) check(t("no assets at the root"), (await req(img.replace("/gallery", "") || "/_nowaki/x")).status === 404);
  check(t("the public variable's default reached the page"), r.body.includes(">Sirocco Gallery</a>"), r.body.slice(0, 1500));

  r = await req("/gallery/ja");
  check(t("/gallery/ja is the Japanese gallery"), r.status === 200 && /<html lang="ja"/.test(r.body) && r.body.includes(`<h1 id="gallery">${JA.gallery}</h1>`) && r.body.includes(`alt="${JA.dune}"`), `${r.status} ${r.body.slice(0, 300)}`);
  check(t("ja links keep the locale"), r.body.includes('id="photo-1" href="/gallery/ja/photo/1"') && r.body.includes('href="/gallery/ja/account"'));
  check(t("the language switcher links to the page in English"), r.body.includes('<a id="lang-en" href="/gallery" hreflang="en">English</a>'), r.body.match(/<span class="lang">.*?<\/span>/)?.[0]);

  // The photo: a full page on a plain request, the modal fragment on the router's request.
  r = await req("/gallery/ja/photo/1");
  check(t("/gallery/ja/photo/1 is the full photo page"), r.status === 200 && r.body.includes('<main id="photo-page"><h1>' + JA.dune + "</h1>") && !r.body.includes('id="photo-modal"'), `${r.status} ${r.body.slice(0, 300)}`);
  check(t("the page carries the modal slot with its intercept pattern"), r.body.includes('<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="/@modal" data-nowaki-intercepts="[&quot;/gallery/ja/photo/[id]&quot;]"></nowaki-slot>'), r.body.match(/<nowaki-slot[^>]*>/)?.[0]);
  check(t("the photo page varies on X-Nowaki-Intercept"), /x-nowaki-intercept/i.test(r.headers.vary ?? ""), r.headers.vary);
  check(t("the switcher on a photo keeps the photo"), r.body.includes('<a id="lang-en" href="/gallery/photo/1" hreflang="en">'));
  r = await req("/gallery/ja/photo/1", { headers: { "x-nowaki-intercept": "/@modal" } });
  check(
    t("the router's request gets the modal fragment"),
    r.status === 200 && r.headers["x-nowaki-slot"] === "modal" && r.body.startsWith("<template data-nowaki-head>") && r.body.includes('<dialog open id="photo-modal"') && r.body.includes(`<h2>${JA.dune}</h2>`) && !r.body.includes("photo-page") && !r.body.includes("<html"),
    `${r.status} ${r.headers["x-nowaki-slot"]} ${r.body.slice(0, 300)}`,
  );
  check(t("the fragment is private and never cached"), r.headers["cache-control"] === "private, no-store", r.headers["cache-control"]);
  const css = dev ? /<template data-nowaki-head>.*\/__nowaki\/css\?f=routes\/%40modal\/%28\.%29photo\/modal\.css/ : /<template data-nowaki-head>.*\/gallery\/_nowaki\/modal\.[0-9a-f]+\.css/;
  check(t("the fragment links the modal's CSS"), css.test(r.body), r.body.slice(0, 300));
  r = await req("/gallery/photo/2", { headers: { "x-nowaki-intercept": "/@modal" } });
  check(t("the English fragment"), r.headers["x-nowaki-slot"] === "modal" && r.body.includes("<h2>Sea</h2>"), r.body.slice(0, 300));
  r = await req("/gallery/photo/9");
  check(t("an unknown photo is a 404"), r.status === 404, `${r.status}`);

  // Redirects: the default locale's prefix, a config redirect, detection.
  r = await req("/gallery/en/photo/2?from=x");
  check(t("/gallery/en/photo/2 → 308 /gallery/photo/2 with the query"), r.status === 308 && r.headers.location === "/gallery/photo/2?from=x", `${r.status} ${r.headers.location}`);
  r = await req("/gallery/en");
  check(t("/gallery/en → 308 /gallery"), r.status === 308 && r.headers.location === "/gallery", `${r.status} ${r.headers.location}`);
  r = await req("/gallery/photos/2");
  check(t("config redirect /photos/[id] → 308 /gallery/photo/[id]"), r.status === 308 && r.headers.location === "/gallery/photo/2", `${r.status} ${r.headers.location}`);
  r = await req("/gallery/ja/photos/2");
  check(t("the config redirect keeps the locale"), r.status === 308 && r.headers.location === "/gallery/ja/photo/2", `${r.status} ${r.headers.location}`);
  r = await req("/gallery", { headers: { "accept-language": "ja-JP,ja;q=0.9,en;q=0.5" } });
  check(t("Accept-Language ja on /gallery → 307 /gallery/ja"), r.status === 307 && r.headers.location === "/gallery/ja" && varies(r) && /private/.test(r.headers["cache-control"] ?? ""), `${r.status} ${r.headers.location} ${r.headers.vary} ${r.headers["cache-control"]}`);
  r = await req("/gallery", { headers: { "accept-language": "ja", cookie: "nowaki_locale=en" } });
  check(t("the switcher's cookie wins over Accept-Language"), r.status === 200 && r.body.includes('<h1 id="gallery">Gallery</h1>'), `${r.status} ${r.headers.location}`);
  r = await req("/gallery", { headers: { "accept-language": "en", cookie: "nowaki_locale=ja" } });
  check(t("a nowaki_locale=ja cookie sends /gallery to /gallery/ja"), r.status === 307 && r.headers.location === "/gallery/ja", `${r.status} ${r.headers.location}`);
  r = await req("/gallery/photo/1", { headers: { "accept-language": "ja" } });
  check(t("only the root is detected"), r.status === 200, `${r.status} ${r.headers.location}`);
  r = await req("/photo/1");
  check(t("outside the base is a 404"), r.status === 404, `${r.status}`);

  // The config header.
  r = await req("/gallery/login");
  check(t("config header on /login"), r.status === 200 && r.headers["x-robots-tag"] === "noindex", `${r.status} ${r.headers["x-robots-tag"]}`);
  r = await req("/gallery/ja/login");
  check(t("config header on /ja/login"), r.status === 200 && r.headers["x-robots-tag"] === "noindex", `${r.status} ${r.headers["x-robots-tag"]}`);
  r = await req("/gallery/photo/1");
  check(t("the header stays on its source"), r.headers["x-robots-tag"] === undefined, r.headers["x-robots-tag"]);

  // The session: sign in, the account page, sign out.
  r = await req("/gallery/ja/account");
  check(t("the account page without a session → sign in (in the locale, under the base)"), r.status === 302 && r.headers.location === "/gallery/ja/login", `${r.status} ${r.headers.location}`);
  r = await req("/gallery/ja/login", form(origin, "password=wrong-password"));
  check(t("a wrong password is refused"), r.status === 401 && r.body.includes(JA.wrong) && !cookieOf(r), `${r.status} ${cookieOf(r)}`);
  r = await req("/gallery/ja/login", form("http://evil.test", `password=${PASSWORD}`));
  check(t("a cross-site sign-in is refused"), r.status === 403 && !cookieOf(r), `${r.status} ${cookieOf(r)}`);
  r = await req("/gallery/ja/login", form(origin, `password=${PASSWORD}`));
  const cookie = cookieOf(r);
  check(t("the right password → 302 /gallery/ja/account"), r.status === 302 && r.headers.location === "/gallery/ja/account", `${r.status} ${r.headers.location}`);
  check(t("the session cookie is set under the base"), /^gallery_session=v1\.[^;]+;.*Path=\/gallery;.*HttpOnly;.*SameSite=Lax/.test(cookie), cookie);
  const session = cookie.split(";")[0];
  r = await req("/gallery/ja/account", { headers: { cookie: session } });
  check(t("the account page shows the signed-in user"), r.status === 200 && r.body.includes(`<p id="signed-in">${JA.signedIn}: <strong>admin</strong></p>`) && r.body.includes('action="/gallery/ja/logout"'), `${r.status} ${r.body.slice(0, 200)}`);
  r = await req("/gallery/account", { headers: { cookie: session } });
  check(t("the session holds in the other locale"), r.status === 200 && r.body.includes("Signed in as: <strong>admin</strong>"), `${r.status}`);
  // A flipped character in the middle (the last one may only carry padding bits).
  const mid = Math.floor((session.indexOf("v1.") + 3 + session.length) / 2);
  const tampered = session.slice(0, mid) + (session[mid] === "A" ? "B" : "A") + session.slice(mid + 1);
  r = await req("/gallery/account", { headers: { cookie: tampered } });
  check(t("a tampered cookie is no session"), r.status === 302 && r.headers.location === "/gallery/login", `${r.status} ${r.headers.location}`);
  r = await req("/gallery/ja/logout", form(origin, "", session));
  const cleared = cookieOf(r);
  check(t("sign-out → 302 /gallery/ja"), r.status === 302 && r.headers.location === "/gallery/ja", `${r.status} ${r.headers.location}`);
  check(t("sign-out clears the cookie"), /^gallery_session=;.*Max-Age=0;.*Path=\/gallery/.test(cleared), cleared);
}

// v0.19: an action updates a post, and the next request for it is fresh. `req` answers from its
// cache (x-nowaki-cache on start and the worker, x-vercel-cache from the CDN stand-in) and `flush`
// waits for the worker's background cache writes.
const cacheOf = (r) => r.headers["x-nowaki-cache"] ?? r.headers["x-vercel-cache"];
const captionOf = (r) => r.body.match(/<p id="caption">([^<]*)<\/p>/)?.[1];
async function postChecks(label, req, origin, { flush = async () => {} } = {}) {
  const t = (s) => `${label}: ${s}`;
  const get = async (p, opts) => {
    const r = await req(p, opts);
    await flush();
    return r;
  };
  let r = await get("/gallery/posts/1");
  check(t("/gallery/posts/1 is the post, with its caption"), r.status === 200 && r.body.includes('<main id="post-page"><h1>Dune</h1>') && captionOf(r) === "A dune at noon.", `${r.status} ${r.body.slice(0, 300)}`);
  check(t("the post is ISR (shared cache-control)"), /public, s-maxage=3600/.test(r.headers["cache-control"] ?? ""), r.headers["cache-control"]);
  check(t("the photo carries its view-transition-name"), r.body.includes('style="view-transition-name:photo-1;"'), r.body.match(/<img[^>]*>/)?.[0]);
  check(t("the caption form posts to the post, under the base"), r.body.includes('<form method="post" id="edit" action="/gallery/posts/1">'));
  check(t("the back link is a View Transition link"), r.body.includes('<a id="all-posts" href="/gallery/posts" data-nowaki-transition>'), r.body.match(/<a id="all-posts"[^>]*>/)?.[0]);
  check(t("no internal cache headers reach the client"), !Object.keys(r.headers).some((k) => ["x-nowaki-tags", "x-nowaki-revalidate", "x-nowaki-vary", "cache-tag"].includes(k)), Object.keys(r.headers).join());
  r = await get("/gallery/posts/1");
  check(t("the next GET of the post is a cache HIT"), cacheOf(r) === "HIT" && captionOf(r) === "A dune at noon.", `${cacheOf(r)} ${captionOf(r)}`);
  for (const p of ["/gallery/ja/posts/1", "/gallery/posts/2", "/gallery/posts"]) {
    await get(p);
    r = await get(p);
    check(t(`${p} is cached too`), r.status === 200 && cacheOf(r) === "HIT", `${r.status} ${cacheOf(r)}`);
  }
  check(t("the list links each post as a View Transition, thumbnails named like the post's photo"), r.body.includes('id="post-1" href="/gallery/posts/1" data-nowaki-transition') && r.body.includes("view-transition-name:photo-2;"), r.body.slice(0, 2000));

  const edit = (caption, headers = {}) => form(origin, `caption=${encodeURIComponent(caption)}`, headers.cookie);
  // Signed out: the posts' middleware sends the POST to sign in; nothing changes.
  r = await req("/gallery/posts/1", edit("signed out"));
  check(t("a signed-out edit → 303 sign in"), r.status === 303 && /\/gallery\/login$/.test(r.headers.location ?? ""), `${r.status} ${r.headers.location}`);
  r = await req("/gallery/login", form(origin, `password=${PASSWORD}`));
  const session = cookieOf(r).split(";")[0];
  check(t("signed in for the edit"), r.status === 302 && session.startsWith("gallery_session="), `${r.status}`);
  // Cross-site, with the cookie: the session reads as empty there, so it is refused the same way.
  r = await req("/gallery/posts/1", form("http://evil.test", "caption=cross-site", session));
  check(t("a cross-site edit is refused"), (r.status === 303 && /\/login$/.test(r.headers.location ?? "")) || r.status === 403, `${r.status} ${r.headers.location}`);
  r = await req("/gallery/posts/1", edit("", { cookie: session }));
  check(t("an empty caption is a 400"), r.status === 400, `${r.status}`);
  r = await get("/gallery/posts/1");
  check(t("none of that purged the post"), cacheOf(r) === "HIT" && captionOf(r) === "A dune at noon.", `${cacheOf(r)} ${captionOf(r)}`);

  const caption = `Edited on ${label} ${Date.now()}`;
  r = await req("/gallery/posts/1", edit(caption, { cookie: session }));
  check(t("the edit → 303 back to the post"), r.status === 303 && /\/gallery\/posts\/1$/.test(r.headers.location ?? ""), `${r.status} ${r.headers.location}`);
  r = await get("/gallery/posts/1");
  check(t("the next GET is fresh: a MISS with the new caption"), r.status === 200 && cacheOf(r) === "MISS" && captionOf(r) === caption, `${cacheOf(r)} ${captionOf(r)}`);
  r = await get("/gallery/ja/posts/1");
  check(t("the post in the other locale is fresh too (same tag)"), cacheOf(r) === "MISS" && captionOf(r) === caption, `${cacheOf(r)} ${captionOf(r)}`);
  r = await get("/gallery/posts/2");
  check(t("another post stays cached (revalidateTag(\"photo:1\") only)"), cacheOf(r) === "HIT", `${cacheOf(r)}`);
  r = await get("/gallery/posts");
  check(t("the list stays cached"), cacheOf(r) === "HIT", `${cacheOf(r)}`);
  r = await get("/gallery/posts/1");
  check(t("then the new render is cached"), cacheOf(r) === "HIT" && captionOf(r) === caption, `${cacheOf(r)} ${captionOf(r)}`);
}

// One request, one trace: `nowaki start` exports to a receiver on `port + 1`. The Rust front's
// SERVER span (child of the client's traceparent), its CLIENT span to the sidecar, the sidecar's
// SERVER span, and under it the posts middleware, the loader and the render.
async function otelChecks(port) {
  const spans = [];
  const receiver = http.createServer((q, res) => {
    const chunks = [];
    q.on("data", (c) => chunks.push(c));
    q.on("end", () => {
      if (q.method === "POST" && q.url === "/v1/traces") {
        for (const rs of JSON.parse(Buffer.concat(chunks).toString("utf8")).resourceSpans ?? []) {
          const lang = (rs.resource?.attributes ?? []).find((a) => a.key === "telemetry.sdk.language")?.value?.stringValue;
          for (const ss of rs.scopeSpans ?? []) {
            for (const sp of ss.spans ?? []) spans.push({ ...sp, lang, attrs: Object.fromEntries((sp.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]])) });
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => receiver.listen(port + 1, "127.0.0.1", r));
  try {
    build(APP);
    const stop = await serve(BIN, ["start", APP, "--port", String(port)], { ...ENV, NOWAKI_ISR_WARM: "0", OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port + 1}`, OTEL_SERVICE_NAME: "gallery-e2e", OTEL_BSP_SCHEDULE_DELAY: "100" }, port);
    const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const trace = hex(16);
    const parent = hex(8);
    const r = await httpClient(port)("/gallery/posts/2", { headers: { traceparent: `00-${trace}-${parent}-01` } });
    check("otel: the post rendered (a MISS: NOWAKI_ISR_WARM=0)", r.status === 200 && r.headers["x-nowaki-cache"] === "MISS", `${r.status} ${r.headers["x-nowaki-cache"]}`);
    const mine = () => spans.filter((sp) => sp.traceId === trace);
    for (let i = 0; i < 100 && !(mine().some((sp) => sp.name === "render") && mine().some((sp) => sp.lang === "rust" && sp.kind === 2)); i++) await sleep(100);
    stop();
    const all = mine();
    const rustServer = all.find((sp) => sp.kind === 2 && sp.lang === "rust");
    const rustClient = all.find((sp) => sp.kind === 3 && sp.parentSpanId === rustServer?.spanId);
    const nodeServer = all.find((sp) => sp.kind === 2 && sp.lang === "nodejs" && sp.parentSpanId === rustClient?.spanId);
    const under = (name) => all.find((sp) => sp.lang === "nodejs" && sp.name === name && sp.parentSpanId === nodeServer?.spanId);
    check("otel: the front's SERVER span names the route and continues the client's trace", rustServer?.name === "GET /posts/[id]" && rustServer.attrs["http.route"] === "/posts/[id]" && rustServer.parentSpanId === parent, JSON.stringify({ name: rustServer?.name, attrs: rustServer?.attrs }));
    check("otel: a CLIENT span to the sidecar, and the sidecar's SERVER span under it", !!rustClient && !!nodeServer, all.map((sp) => `${sp.lang}:${sp.kind}:${sp.name}`).join(", "));
    check("otel: the posts middleware, the loader and the render, under the sidecar's span", !!under("middleware /posts") && !!under("loader") && !!under("render"), all.map((sp) => `${sp.lang}:${sp.name}`).join(", "));
    check("otel: all of it one trace from one service", all.length >= 6 && all.every((sp) => sp.traceId === trace), `${all.length} spans`);
  } finally {
    receiver.close();
  }
}

// What static output can express. The full app can't be exported: its account page reads the
// session, and a static file is the same for every visitor. A copy without the session pages can.
function staticChecks() {
  const full = nowaki(["build", APP, "--adapter", "static"]);
  check(
    "static: the full app is refused, naming the session page",
    full.status !== 0 && /\/account: the page failed to render/.test(output(full)) && output(full).includes("ctx.session can't be used in a prerendered page"),
    output(full).slice(-1500),
  );
  check("static: the refusal never prints the variables", !output(full).includes(PASSWORD) && !output(full).includes(SECRET));

  const dir = path.join(tmp, "static");
  const skip = new Set(["node_modules", "dist", ".nowaki", "(account)", "login.tsx", "logout.tsx"]);
  cpSync(APP, dir, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  linkModules(path.join(APP, "node_modules"), path.join(dir, "node_modules"));
  const log = build(dir, "static");
  const out = path.join(dir, "dist/static");
  const read = (f) => (existsSync(path.join(out, f)) ? readFileSync(path.join(out, f), "utf8") : "");
  check("static: i18n.detect warns that a static host can't negotiate", log.includes("i18n.detect"), log.slice(-800));
  check("static: a page per locale", /<html lang="en"/.test(read("index.html")) && read("ja/index.html").includes(`<h1 id="gallery">${JA.gallery}</h1>`));
  check("static: a photo page per photo and locale", ["photo/1", "photo/3", "ja/photo/1", "ja/photo/3"].every((p) => read(`${p}/index.html`).includes('id="photo-page"')));
  check("static: the posts and their list, per locale", ["posts", "ja/posts"].every((p) => read(`${p}/index.html`).includes('id="posts"')) && ["posts/1", "ja/posts/3"].every((p) => read(`${p}/index.html`).includes('<p id="caption">')));
  const ja = read("ja/photo/1/index.html");
  check("static: hreflang with the base", ja.includes(`hreflang="en" href="${SITE}/gallery/photo/1/"`) && ja.includes(`hreflang="ja" href="${SITE}/gallery/ja/photo/1/"`), ja.slice(0, 1500));
  const img = ja.match(/<img src="([^"]+)"/)?.[1] ?? "";
  check("static: assets referenced under the base, written at the site root", img.startsWith("/gallery/_nowaki/") && existsSync(path.join(out, img.slice("/gallery/".length))), img);
  const redirects = read("_redirects");
  check("static: the config redirect in _redirects", redirects.includes("/gallery/photos/:id /gallery/photo/:id 308") && redirects.includes("/gallery/ja/photos/:id /gallery/ja/photo/:id 308"), redirects);
  check("static: /gallery/en in _redirects", redirects.includes("/gallery/en /gallery 308"), redirects);
  check("static: the config header in _headers", /\/gallery\/login\n\s+x-robots-tag: noindex/.test(read("_headers")) && /\/gallery\/ja\/login\n\s+x-robots-tag: noindex/.test(read("_headers")), read("_headers"));
  check("static: no fragment can be served (the router falls back to the page)", !existsSync(path.join(out, "@modal")));
}

// env.ts: a missing or invalid variable stops the build and the server, named, value unprinted.
function envChecks() {
  const { GALLERY_ADMIN_PASSWORD: _, ...noPassword } = ENV;
  let r = nowaki(["build", APP], noPassword);
  check("env: build fails without GALLERY_ADMIN_PASSWORD, naming it", r.status !== 0 && r.status !== null && /GALLERY_ADMIN_PASSWORD: missing/.test(output(r)), `${r.status} ${output(r).slice(-800)}`);
  check("env: the failed build prints no variable's value", !output(r).includes(SECRET), output(r).slice(-800));
  const shortSecret = "e2e-short-sentinel";
  r = nowaki(["build", APP], { ...ENV, NOWAKI_SESSION_SECRET: shortSecret });
  check("env: build fails on a short NOWAKI_SESSION_SECRET, naming it", r.status !== 0 && /NOWAKI_SESSION_SECRET: /.test(output(r)), output(r).slice(-800));
  check("env: the invalid value is never printed", !output(r).includes(shortSecret) && !output(r).includes(PASSWORD), output(r).slice(-800));

  build(APP);
  r = nowaki(["start", APP, "--port", String(PORT)], noPassword, 60_000);
  check("env: nowaki start exits non-zero without GALLERY_ADMIN_PASSWORD, naming it", r.status !== 0 && r.status !== null && /GALLERY_ADMIN_PASSWORD: missing/.test(output(r)), `${r.status} ${output(r).slice(-800)}`);
  check("env: nowaki start prints no variable's value", !output(r).includes(SECRET), output(r).slice(-800));
}

// Each package is linked to its real directory by an absolute junction (see rules-e2e.mjs: a
// whole-node_modules junction breaks pnpm's relative links under `nowaki dev` on Windows).
function linkModules(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === ".bin" || name === ".cache") continue;
    const src = path.join(from, name);
    if (name.startsWith("@") && statSync(src).isDirectory() && !lstatSync(src).isSymbolicLink()) {
      linkModules(src, path.join(to, name));
      continue;
    }
    symlinkSync(realpathSync(src), path.join(to, name), "junction");
  }
}

const local = (port) => `http://127.0.0.1:${port}`;

try {
  for (const mode of modes) {
    console.log(`\n--- ${mode} ---`);
    if (mode === "start") {
      build(APP);
      const stop = await serve(BIN, ["start", APP, "--port", String(PORT)], ENV, PORT);
      await checks("start", httpClient(PORT), local(PORT));
      await postChecks("start", httpClient(PORT), local(PORT));
      stop();
    } else if (mode === "dev") {
      const stop = await serve(BIN, ["dev", APP, "--port", String(PORT)], ENV, PORT);
      await checks("dev", httpClient(PORT), local(PORT), { dev: true });
      stop();
    } else if (mode === "node") {
      build(APP, "node");
      const stop = await serve("node", [path.join(APP, "dist/server/index.mjs")], { ...ENV, PORT: String(PORT), NOWAKI_HOST: "127.0.0.1" }, PORT);
      await checks("node", httpClient(PORT), local(PORT));
      // No ISR store here: the post goes out with its shared Cache-Control (for a CDN in front),
      // and the headers meant for the `nowaki start` cache stay internal.
      const post = await httpClient(PORT)("/gallery/posts/1");
      check(
        "node: an ISR post sends s-maxage and no internal cache headers",
        post.status === 200 && /public, s-maxage=3600/.test(post.headers["cache-control"] ?? "") && !Object.keys(post.headers).some((k) => k.startsWith("x-nowaki-")),
        Object.keys(post.headers).join(),
      );
      stop();
    } else if (mode === "cloudflare") {
      build(APP, "cloudflare");
      await checks("cloudflare", await workerClient(APP), "https://app.example");
      const cached = await workerClient(APP, { cache: true });
      await postChecks("cloudflare", cached, "https://app.example", { flush: cached.flush });
      check("cloudflare: the edit purged by tag through the zone purge API", cached.zonePurges.length === 1 && cached.zonePurges[0].url.endsWith("/zones/gallery-zone/purge_cache") && cached.zonePurges[0].tags.join() === "t:photo:1", JSON.stringify(cached.zonePurges));
      delete globalThis.caches;
    } else if (mode === "vercel") {
      const req = await vercelClient(PORT);
      try {
        await postChecks("vercel", req, local(PORT));
        check("vercel: the edit deleted the tag through @vercel/functions", req.deletes.length === 1 && req.deletes[0].join() === "t:photo:1", JSON.stringify(req.deletes));
      } finally {
        await req.close();
      }
    } else if (mode === "otel") {
      await otelChecks(PORT);
    } else if (mode === "static") {
      staticChecks();
    } else if (mode === "env") {
      envChecks();
    }
  }
} catch (e) {
  console.error(e);
  failed++;
}

console.log(failed ? `\nGALLERY E2E FAILED (${failed})` : "\nGALLERY E2E PASSED");
process.exit(failed ? 1 : 0);
