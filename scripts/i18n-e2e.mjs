// i18n end to end (nowaki.config `i18n`, en default, ja prefixed): locale routing, ctx.locale /
// getLocale() (page, island SSR), <html lang>, hreflang, the default-locale redirect, per-locale
// content, the 404 page, sitemap alternates, and static output per locale, on a small app
// generated into a temp directory (linked to examples/hello's node_modules).
// A second app ("combo", on --port + 1) composes i18n with basePath "/app", trailingSlash
// "never" and a parallel-route slot: prefixed URLs, canonical / hreflang / sitemap, the locale
// redirect, static file names and _redirects, and the slot (with an intercepting route) under a
// locale.
// A third app ("detect", on --port + 2) turns on `i18n.detect`: Accept-Language and the
// nowaki_locale cookie on `/`, Vary / Cache-Control, and an ISR root never answering another
// language.
//   node scripts/i18n-e2e.mjs <mode>... [--port 4990]
// Modes: start (`nowaki start`), dev (`nowaki dev`), node (node adapter), cloudflare (the worker's
// fetch, called in Node), static (prerender output). NOWAKI_BIN overrides the binary (default
// target/debug/nowaki).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4990;
const modes = args.filter((a, i) => !a.startsWith("--") && (portArg < 0 || i !== portArg + 1));
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const KNOWN = ["start", "dev", "node", "cloudflare", "static"];
if (!modes.length || modes.some((m) => !KNOWN.includes(m))) {
  console.error(`usage: node scripts/i18n-e2e.mjs <${KNOWN.join("|")}>... [--port 4990]`);
  process.exit(2);
}

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = {
  "package.json": `{ "name": "i18n-e2e", "private": true, "type": "module" }\n`,
  "nowaki.config.mjs": `export default {
  site: "https://example.com",
  i18n: { locales: ["en", "ja"], defaultLocale: "en" },
};
`,
  "routes/index.tsx": `import { getLocale } from "@nowaki-dev/runtime";
export default function Home() { return <main>{\`HOME \${getLocale()}\`}</main>; }\n`,
  "routes/about.tsx": `import { getLocale } from "@nowaki-dev/runtime";
import { href, Link } from "@nowaki-dev/runtime/navigation";
import Where from "../islands/Where.tsx";
export const loader = (ctx) => ({ locale: ctx.locale, path: ctx.url.pathname });
export default function About({ data }) {
  return (
    <main>
      <p>{\`ABOUT locale:\${data.locale} get:\${getLocale()} url:\${data.path}\`}</p>
      <Link href="/about" locale="ja">ja</Link>
      <Link id="keep" href="/blog/hello">keep</Link>
      <Link id="raw" href="/blog/hello" locale={false}>raw</Link>
      <form id="f" method="post" action={href("/about")}></form>
      <Where />
    </main>
  );
}\n`,
  "islands/Where.tsx": `import { getLocale, Link } from "@nowaki-dev/runtime/navigation";
export default function Where() { return <span>{\`WHERE \${getLocale()}\`}<Link id="island-keep" href="/blog/hello">i</Link></span>; }\n`,
  "routes/blog/[slug].tsx": `import { getCollection, getEntry } from "@nowaki-dev/runtime/content";
export const staticPaths = async () => (await getCollection("blog")).map((e) => ({ slug: e.slug }));
export const loader = async (ctx) => ({ entry: await getEntry("blog", ctx.params.slug), count: (await getCollection("blog")).length });
export default function Post({ data }) {
  return <main>{data.entry ? \`POST \${data.entry.data.title} n:\${data.count}\` : "POST MISSING"}</main>;
}\n`,
  "routes/isr.tsx": `import { getLocale } from "@nowaki-dev/runtime";
export const revalidate = 60;
export default function Isr() { return <main>{\`ISR \${getLocale()}\`}</main>; }\n`,
  "routes/_404.tsx": `import { getLocale } from "@nowaki-dev/runtime";
export default function NotFound() { return <main>{\`NOTFOUND \${getLocale()}\`}</main>; }\n`,
  "content/config.ts": `import { defineCollection } from "@nowaki-dev/runtime/content";
export const blog = defineCollection({});\n`,
  "content/blog/en/hello.md": "---\ntitle: Hello\n---\nhi\n",
  "content/blog/ja/hello.md": "---\ntitle: Konnichiwa\n---\nhi\n",
  "content/blog/ja/only-ja.md": "---\ntitle: OnlyJa\n---\nhi\n",
};

// i18n + basePath + trailingSlash "never" + a parallel-route slot, together.
const COMBO = {
  ...FILES,
  "nowaki.config.mjs": `export default {
  site: "https://example.com",
  basePath: "/app",
  trailingSlash: "never",
  i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true },
};
`,
  "routes/about.tsx": FILES["routes/about.tsx"].replace("export const loader", "export const meta = { canonical: true };\nexport const loader"),
  "routes/photos/_layout.tsx": `export default function Photos({ children, slots }) { return <div data-photos>{children}{slots.modal}</div>; }\n`,
  "routes/photos/index.tsx": `export default function List() { return <h1>PHOTOS</h1>; }\n`,
  "routes/photos/[id].tsx": `import { getLocale } from "@nowaki-dev/runtime";
export const staticPaths = () => [{ id: "1" }];
export default function Photo({ params }) { return <h1>{\`PHOTO \${params.id} \${getLocale()}\`}</h1>; }\n`,
  "routes/photos/@modal/[id].tsx": `import { getLocale } from "@nowaki-dev/runtime";
export const loader = (ctx) => ({ id: ctx.params.id });
export default function Modal({ data }) { return <aside>{\`MODAL \${data.id} \${getLocale()}\`}</aside>; }\n`,
  "routes/photos/@modal/default.tsx": `export default function NoModal() { return <p>NOMODAL</p>; }\n`,
  "routes/photos/@modal/(.)[id].tsx": `import { getLocale } from "@nowaki-dev/runtime";
export default function Intercepted({ params }) { return <aside>{\`INTERCEPTED \${params.id} \${getLocale()}\`}</aside>; }\n`,
};

// i18n.detect, with an ISR root.
const DETECT = {
  ...FILES,
  "nowaki.config.mjs": `export default {
  site: "https://example.com",
  i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true },
};
`,
  "routes/index.tsx": `import { getLocale } from "@nowaki-dev/runtime";
export const revalidate = 60;
export default function Home() { return <main>{\`HOME \${getLocale()}\`}</main>; }\n`,
};

async function detectChecks(label, req, { isr = false } = {}) {
  const t = (s) => `${label} detect: ${s}`;
  const varies = (r) => /accept-language/i.test(r.headers.vary ?? "") && /cookie/i.test(r.headers.vary ?? "");
  const ja = { "accept-language": "ja-JP,ja;q=0.9,en;q=0.5" };
  if (isr) {
    // Fill the root's ISR entry from an English visitor first.
    await req("/", { headers: { "accept-language": "en" } });
    const hit = await req("/", { headers: { "accept-language": "en-US" } });
    check(t("an English visitor gets the cached root"), hit.status === 200 && hit.body.includes("HOME en") && hit.headers["x-nowaki-cache"] === "HIT" && varies(hit), `${hit.status} ${hit.headers["x-nowaki-cache"]} ${hit.headers.vary}`);
  }
  let r = await req("/?utm=1", { headers: ja });
  check(t("Accept-Language ja on / → 307 /ja with the query"), r.status === 307 && r.headers.location === "/ja?utm=1", `${r.status} ${r.headers.location} ${r.body.slice(0, 120)}`);
  check(t("the redirect varies and is private"), varies(r) && /private/.test(r.headers["cache-control"] ?? ""), `${r.headers.vary} ${r.headers["cache-control"]}`);
  check(t("the redirect has the security headers"), r.headers["x-content-type-options"] === "nosniff", JSON.stringify(r.headers));
  r = await req("/", { method: "HEAD", headers: ja });
  check(t("HEAD / is detected too"), r.status === 307 && r.headers.location === "/ja", `${r.status} ${r.headers.location}`);
  r = await req("/", { headers: { "accept-language": "en-GB,en;q=0.9,ja;q=0.8" } });
  check(t("English stays on / with Vary"), r.status === 200 && r.body.includes("HOME en") && varies(r), `${r.status} ${r.headers.vary}`);
  r = await req("/");
  check(t("no Accept-Language stays on /"), r.status === 200 && r.body.includes("HOME en") && varies(r), `${r.status} ${r.headers.vary}`);
  r = await req("/", { headers: { ...ja, cookie: "nowaki_locale=en" } });
  check(t("the nowaki_locale cookie wins over Accept-Language"), r.status === 200 && r.body.includes("HOME en"), `${r.status} ${r.headers.location}`);
  r = await req("/", { headers: { "accept-language": "en", cookie: "theme=dark; nowaki_locale=ja" } });
  check(t("a cookie naming a locale redirects to it"), r.status === 307 && r.headers.location === "/ja", `${r.status} ${r.headers.location}`);
  r = await req("/", { headers: { "accept-language": "en", cookie: "nowaki_locale=%2F%2Fevil.com" } });
  check(t("an invalid cookie is ignored"), r.status === 200 && r.body.includes("HOME en"), `${r.status} ${r.headers.location}`);
  r = await req("/", { headers: { "accept-language": "ja;q=0, en" } });
  check(t("q=0 is not acceptable"), r.status === 200, `${r.status} ${r.headers.location}`);
  r = await req("/about", { headers: ja });
  check(t("only / is detected"), r.status === 200 && r.body.includes("ABOUT locale:en") && !/accept-language/i.test(r.headers.vary ?? ""), `${r.status} ${r.headers.vary}`);
  r = await req("/ja", { headers: { "accept-language": "en" } });
  check(t("/ja is never redirected"), r.status === 200 && r.body.includes("HOME ja"), `${r.status}`);
  r = await req("/", { method: "POST", headers: { ...ja, "content-type": "text/plain" } });
  check(t("POST / is not detected"), r.headers.location !== "/ja", `${r.status} ${r.headers.location}`);
  if (isr) {
    const after = await req("/", { headers: { "accept-language": "ja" } });
    check(t("the cached English root never answers a Japanese visitor"), after.status === 307 && !after.body.includes("HOME en"), `${after.status} ${after.headers["x-nowaki-cache"]}`);
  }
}

async function comboChecks(label, req) {
  const t = (s) => `${label} combo: ${s}`;
  let r = await req("/app/ja/about");
  check(t("/app/ja/about renders in ja with the browser URL"), r.status === 200 && /<html lang="ja"/.test(r.body) && r.body.includes("ABOUT locale:ja get:ja url:/app/ja/about"), `${r.status} ${r.body.slice(0, 300)}`);
  check(t("canonical carries base + locale, no slash"), r.body.includes('rel="canonical" href="https://example.com/app/ja/about"'), r.body.match(/rel="canonical"[^>]*/)?.[0]);
  check(
    t("hreflang alternates carry the base"),
    r.body.includes('hreflang="ja" href="https://example.com/app/ja/about"') &&
      r.body.includes('hreflang="en" href="https://example.com/app/about"') &&
      r.body.includes('hreflang="x-default" href="https://example.com/app/about"'),
    r.body.slice(0, 900),
  );
  check(t("<Link locale> gets the base after the locale"), r.body.includes('href="/app/ja/about" hreflang="ja"'), r.body.slice(0, 900));
  check(t("<Link> and href() keep the locale under the base"), r.body.includes('id="keep" href="/app/ja/blog/hello"') && r.body.includes('id="island-keep" href="/app/ja/blog/hello"') && r.body.includes('id="raw" href="/app/blog/hello"') && r.body.includes('action="/app/ja/about"'), r.body.slice(0, 1200));
  r = await req("/app/ja/about/");
  check(t("/app/ja/about/ → 308 /app/ja/about (never)"), r.status === 308 && r.headers.location === "/app/ja/about", `${r.status} ${r.headers.location}`);
  r = await req("/app/en/about?x=1");
  check(t("/app/en/about → 308 /app/about with the query"), r.status === 308 && r.headers.location === "/app/about?x=1", `${r.status} ${r.headers.location}`);
  r = await req("/app/en");
  check(t("/app/en → 308 /app (the bare base under never)"), r.status === 308 && r.headers.location === "/app", `${r.status} ${r.headers.location}`);
  r = await req("/app/en//evil.com");
  check(t("/app/en//evil.com is no open redirect"), !(r.status >= 300 && r.status < 400) || !/^\/[/\\]/.test(r.headers.location ?? ""), `${r.status} ${r.headers.location}`);
  r = await req("/ja/about");
  check(t("outside the base is a 404"), r.status === 404, `${r.status}`);
  r = await req("/app/ja");
  check(t("/app/ja is the locale's home"), r.status === 200 && r.body.includes("HOME ja"), `${r.status}`);
  r = await req("/app", { headers: { "accept-language": "ja" } });
  check(t("detection on the bare base → 307 /app/ja"), r.status === 307 && r.headers.location === "/app/ja", `${r.status} ${r.headers.location}`);
  r = await req("/app/", { headers: { "accept-language": "ja" } });
  check(t("/app/ → 308 /app first (never)"), r.status === 308 && r.headers.location === "/app", `${r.status} ${r.headers.location}`);
  r = await req("/app", { headers: { "accept-language": "en" } });
  check(t("English stays on the bare base"), r.status === 200 && r.body.includes("HOME en") && /accept-language/i.test(r.headers.vary ?? ""), `${r.status} ${r.headers.vary}`);
  r = await req("/app/ja/photos/1");
  check(t("slot renders under base + locale"), r.status === 200 && r.body.includes("PHOTO 1 ja") && /<nowaki-slot name="modal" style="display:contents" data-nowaki-slot="\/photos\/@modal" data-nowaki-intercepts="\[&quot;\/app\/ja\/photos\/\[id\]&quot;\]"><aside>MODAL 1 ja<\/aside><\/nowaki-slot>/.test(r.body), `${r.status} ${r.body.slice(0, 600)}`);
  r = await req("/app/ja/photos");
  check(t("slot default under base + locale"), r.status === 200 && r.body.includes("PHOTOS") && r.body.includes("<p>NOMODAL</p>"), `${r.status} ${r.body.slice(0, 400)}`);
  r = await req("/app/photos/1");
  check(t("slot renders under the base in the default locale"), r.status === 200 && r.body.includes("MODAL 1 en"), `${r.status}`);
  check(t("the default locale's intercept patterns carry the base only"), r.body.includes('data-nowaki-intercepts="[&quot;/app/photos/[id]&quot;]"'), r.body.match(/<nowaki-slot[^>]*>/)?.[0]);
  r = await req("/app/ja/photos/1", { headers: { "x-nowaki-intercept": "/photos/@modal" } });
  check(t("intercepting route under base + locale: the fragment"), r.status === 200 && r.headers["x-nowaki-slot"] === "modal" && r.body.endsWith("<aside>INTERCEPTED 1 ja</aside>"), `${r.status} ${r.body.slice(-200)}`);
  r = await req("/app/sitemap.xml");
  check(
    t("sitemap: base + locale, no trailing slashes, alternates"),
    r.status === 200 &&
      r.body.includes("<loc>https://example.com/app/ja/about</loc>") &&
      r.body.includes("<loc>https://example.com/app</loc>") &&
      r.body.includes('hreflang="en" href="https://example.com/app/about"') &&
      !/\/<\/loc>|\/"\/>/.test(r.body),
    r.body.slice(0, 600),
  );
}

function staticCombo(dir) {
  const out = path.join(dir, "dist/static");
  const read = (f) => (existsSync(path.join(out, f)) ? readFileSync(path.join(out, f), "utf8") : "");
  const ja = read("ja/about.html");
  check("static combo: x.html per locale (never)", /<html lang="ja"/.test(ja) && read("about.html").includes("ABOUT locale:en") && read("ja.html").includes("HOME ja") && !existsSync(path.join(out, "ja/about/index.html")));
  check("static combo: pages requested under the base", ja.includes("url:/app/ja/about"), ja.slice(0, 300));
  check("static combo: <Link> and href() keep base + locale", ja.includes('id="keep" href="/app/ja/blog/hello"') && ja.includes('action="/app/ja/about"'), ja.slice(0, 1200));
  check("static combo: canonical without the slash", ja.includes('rel="canonical" href="https://example.com/app/ja/about"'), ja.match(/rel="canonical"[^>]*/)?.[0]);
  check("static combo: hreflang with the base, no slash", ja.includes('hreflang="en" href="https://example.com/app/about"') && ja.includes('hreflang="ja" href="https://example.com/app/ja/about"'), ja.slice(0, 900));
  check("static combo: slot page per locale", read("ja/photos/1.html").includes("MODAL 1 ja") && read("photos/1.html").includes("MODAL 1 en"));
  check("static combo: staticPaths per locale", read("ja/blog/hello.html").includes("POST Konnichiwa") && read("blog/hello.html").includes("POST Hello"));
  check("static combo: a 404.html per locale", read("404.html").includes("NOTFOUND en") && read("ja/404.html").includes("NOTFOUND ja"));
  check("static combo: _redirects sends /app/en under the base", read("_redirects").includes("/app/en /app 308\n/app/en/* /app/:splat 308\n"), read("_redirects"));
  const sm = read("sitemap.xml");
  check("static combo: sitemap with the base, no slashes", sm.includes("<loc>https://example.com/app/ja/about</loc>") && sm.includes('hreflang="en" href="https://example.com/app/about"') && !/\/<\/loc>|\/"\/>/.test(sm), sm.slice(0, 600));
}

// The Cloudflare worker's fetch, called in Node, with an ASSETS binding serving dist/worker/assets.
async function workerClient(dir) {
  const workerDir = path.join(dir, "dist/worker");
  const worker = (await import(pathToFileURL(path.join(workerDir, "index.js")).href)).default;
  const ASSETS = {
    fetch: async (request) => {
      const file = path.join(workerDir, "assets", decodeURIComponent(new URL(request.url).pathname));
      return existsSync(file) && !file.endsWith(path.sep) ? new Response(readFileSync(file)) : new Response("missing", { status: 404 });
    },
  };
  return async (p, { method = "GET", headers = {} } = {}) => {
    const res = await worker.fetch(new Request(`https://app.example${p}`, { method, headers, redirect: "manual" }), { ASSETS });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  };
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-i18n-e2e-"));
const children = new Set();
const cleanup = () => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

function makeApp(name, files = FILES) {
  const dir = path.join(tmp, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(dir, "node_modules"));
  return dir;
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

function build(dir, adapter) {
  const r = spawnSync(BIN, ["build", dir, ...(adapter ? ["--adapter", adapter] : [])], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`nowaki build ${adapter ?? ""} failed`);
  }
  return r.stdout + r.stderr;
}

async function serve(cmd, argv, opts, port) {
  const child = spawn(cmd, argv, { stdio: ["pipe", "inherit", "inherit"], ...opts });
  children.add(child);
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/__nowaki/boundaries" }, (res) => {
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

const httpClient = (port) => (p, { method = "GET", headers = {} } = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
    req.end();
  });

async function checks(label, req, { isr = false } = {}) {
  const t = (s) => `${label}: ${s}`;
  let r = await req("/ja/about");
  check(t("/ja/about renders with ctx.locale and getLocale()"), r.status === 200 && r.body.includes("ABOUT locale:ja get:ja url:/ja/about"), `${r.status} ${r.body.slice(0, 300)}`);
  check(t("<html lang> is the locale"), /<html lang="ja"/.test(r.body), r.body.slice(0, 120));
  check(t("island SSR sees the locale"), r.body.includes("WHERE ja"), r.body.slice(0, 400));
  check(
    t("hreflang alternates and x-default"),
    r.body.includes('<link rel="alternate" hreflang="ja" href="https://example.com/ja/about" />') &&
      r.body.includes('<link rel="alternate" hreflang="en" href="https://example.com/about" />') &&
      r.body.includes('<link rel="alternate" hreflang="x-default" href="https://example.com/about" />'),
    r.body.slice(0, 800),
  );
  check(t("<Link locale> links to the localized page"), r.body.includes('href="/ja/about" hreflang="ja"'));
  check(t("<Link> keeps the locale (page and island SSR)"), r.body.includes('id="keep" href="/ja/blog/hello"') && r.body.includes('id="island-keep" href="/ja/blog/hello"'), r.body.slice(0, 1200));
  check(t("<Link locale={false}> and href() for a form action"), r.body.includes('id="raw" href="/blog/hello"') && r.body.includes('action="/ja/about"'), r.body.slice(0, 1200));
  check(t("the page carries the client's i18n settings"), r.body.includes("data-nowaki-i18n="));
  r = await req("/about");
  check(t("/about is the default locale"), r.status === 200 && /<html lang="en"/.test(r.body) && r.body.includes("ABOUT locale:en get:en url:/about"), r.body.slice(0, 300));
  check(t("in the default locale <Link> and href() add no prefix"), r.body.includes('id="keep" href="/blog/hello"') && r.body.includes('action="/about"'), r.body.slice(0, 1200));
  r = await req("/ja");
  check(t("/ja is the locale's home"), r.status === 200 && r.body.includes("HOME ja"), `${r.status}`);
  r = await req("/en/about?x=1");
  check(t("/en/about → 308 /about with the query"), r.status === 308 && r.headers.location === "/about?x=1", `${r.status} ${r.headers.location}`);
  r = await req("/en//evil.com");
  check(t("/en//evil.com is no open redirect"), !(r.status >= 300 && r.status < 400) || !/^\/[/\\]/.test(r.headers.location ?? ""), `${r.status} ${r.headers.location}`);
  r = await req("/ja/blog/hello");
  check(t("per-locale content (ja)"), r.status === 200 && r.body.includes("POST Konnichiwa n:2"), r.body.slice(0, 300));
  r = await req("/blog/hello");
  check(t("per-locale content (en)"), r.status === 200 && r.body.includes("POST Hello n:1"), r.body.slice(0, 300));
  r = await req("/blog/only-ja");
  check(t("an entry only in ja isn't found in en"), r.body.includes("POST MISSING"), r.body.slice(0, 300));
  r = await req("/ja/nope");
  check(t("a 404 under /ja renders in ja"), r.status === 404 && r.body.includes("NOTFOUND ja") && /<html lang="ja"/.test(r.body), `${r.status} ${r.body.slice(0, 200)}`);
  r = await req("/sitemap.xml");
  check(t("sitemap.xml has every locale with xhtml:link alternates"), r.status === 200 && r.body.includes("<loc>https://example.com/ja/about</loc>") && r.body.includes('hreflang="ja" href="https://example.com/ja/about"'), r.body.slice(0, 400));
  r = await req("/ja/sitemap.xml");
  check(t("no sitemap under a locale"), r.status === 404, `${r.status}`);
  if (isr) {
    await req("/isr");
    const ja1 = await req("/ja/isr");
    const ja2 = await req("/ja/isr");
    check(t("ISR caches each locale under its own URL"), ja1.body.includes("ISR ja") && ja2.body.includes("ISR ja") && ja2.headers["x-nowaki-cache"] === "HIT", `${ja2.headers["x-nowaki-cache"]} ${ja2.body.slice(0, 200)}`);
  }
}

const app = makeApp("app");
const combo = makeApp("combo", COMBO);
const detect = makeApp("detect", DETECT);
const P2 = PORT + 1;
const P3 = PORT + 2;

try {
  for (const mode of modes) {
    console.log(`\n--- ${mode} ---`);
    if (mode === "start") {
      build(app);
      const stop = await serve(BIN, ["start", app, "--port", String(PORT)], {}, PORT);
      await checks("start", httpClient(PORT), { isr: true });
      stop();
      build(combo);
      const stop2 = await serve(BIN, ["start", combo, "--port", String(P2)], {}, P2);
      await comboChecks("start", httpClient(P2));
      stop2();
      build(detect);
      const stop3 = await serve(BIN, ["start", detect, "--port", String(P3)], { env: { ...process.env, NOWAKI_ISR_WARM: "0" } }, P3);
      await detectChecks("start", httpClient(P3), { isr: true });
      stop3();
    } else if (mode === "dev") {
      const stop = await serve(BIN, ["dev", app, "--port", String(PORT)], {}, PORT);
      await checks("dev", httpClient(PORT));
      const nav = await httpClient(PORT)("/node_modules/@nowaki-dev/runtime/navigation.js");
      const spec = nav.body.match(/from\s*["']([^"']*i18n\.mjs[^"']*)["']/)?.[1];
      // (The module itself is served from /@fs/, which this temp app outside the workspace may not
      // read; e2e-dev.sh loads it through examples/hello.)
      check("dev: the browser can load navigation.js, which imports the i18n module", nav.status === 200 && /server\/i18n\.mjs/.test(spec ?? ""), `${nav.status} ${spec}`);
      stop();
      const stop2 = await serve(BIN, ["dev", combo, "--port", String(P2)], {}, P2);
      await comboChecks("dev", httpClient(P2));
      stop2();
      const stop3 = await serve(BIN, ["dev", detect, "--port", String(P3)], {}, P3);
      await detectChecks("dev", httpClient(P3));
      stop3();
    } else if (mode === "node") {
      build(app, "node");
      const stop = await serve("node", [path.join(app, "dist/server/index.mjs")], { env: { ...process.env, PORT: String(PORT), NOWAKI_HOST: "127.0.0.1" } }, PORT);
      await checks("node", httpClient(PORT));
      stop();
      build(combo, "node");
      const stop2 = await serve("node", [path.join(combo, "dist/server/index.mjs")], { env: { ...process.env, PORT: String(P2), NOWAKI_HOST: "127.0.0.1" } }, P2);
      await comboChecks("node", httpClient(P2));
      stop2();
      build(detect, "node");
      const stop3 = await serve("node", [path.join(detect, "dist/server/index.mjs")], { env: { ...process.env, PORT: String(P3), NOWAKI_HOST: "127.0.0.1" } }, P3);
      await detectChecks("node", httpClient(P3));
      stop3();
    } else if (mode === "cloudflare") {
      build(app, "cloudflare");
      await checks("cloudflare", await workerClient(app));
      build(combo, "cloudflare");
      await comboChecks("cloudflare", await workerClient(combo));
      build(detect, "cloudflare");
      await detectChecks("cloudflare", await workerClient(detect));
    } else if (mode === "static") {
      build(app, "static");
      const out = path.join(app, "dist/static");
      const read = (f) => (existsSync(path.join(out, f)) ? readFileSync(path.join(out, f), "utf8") : "");
      check("static: ja/about/index.html in ja", /<html lang="ja"/.test(read("ja/about/index.html")) && read("ja/about/index.html").includes("ABOUT locale:ja"));
      check("static: <Link> and href() keep the locale", read("ja/about/index.html").includes('id="keep" href="/ja/blog/hello"') && read("ja/about/index.html").includes('action="/ja/about"') && read("about/index.html").includes('id="keep" href="/blog/hello"'));
      check("static: about/index.html in en", read("about/index.html").includes("ABOUT locale:en"));
      check("static: ja/index.html", read("ja/index.html").includes("HOME ja"));
      check("static: hreflang with trailing slashes", read("ja/about/index.html").includes('hreflang="en" href="https://example.com/about/"'), read("ja/about/index.html").slice(0, 600));
      check("static: staticPaths per locale", read("ja/blog/hello/index.html").includes("POST Konnichiwa") && read("blog/hello/index.html").includes("POST Hello") && read("ja/blog/only-ja/index.html").includes("POST OnlyJa"));
      check("static: no page for an entry the locale lacks", !existsSync(path.join(out, "blog/only-ja")));
      check("static: a 404.html per locale", read("404.html").includes("NOTFOUND en") && read("ja/404.html").includes("NOTFOUND ja"));
      check("static: _redirects sends /en to the unprefixed URLs", read("_redirects").includes("/en / 308\n/en/* /:splat 308\n"), read("_redirects"));
      check("static: sitemap alternates", read("sitemap.xml").includes('hreflang="ja" href="https://example.com/ja/about/"'), read("sitemap.xml").slice(0, 400));
      build(combo, "static");
      staticCombo(combo);
      const log = build(detect, "static");
      check("static: i18n.detect warns that a static host can't negotiate", log.includes("i18n.detect"), log.slice(-600));
    }
  }
} catch (e) {
  console.error(e);
  failed++;
}

console.log(failed ? `\nI18N E2E FAILED (${failed})` : "\nI18N E2E PASSED");
process.exit(failed ? 1 : 0);
