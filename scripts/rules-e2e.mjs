// nowaki.config routing end to end: redirects, rewrites, headers, basePath and trailingSlash at
// every front, on a small app generated into a temp directory (linked to examples/hello's
// node_modules). Two configs: A (redirects / rewrites / headers) and B (basePath "/app" with
// trailingSlash "never").
//   node scripts/rules-e2e.mjs <mode>... [--port 4820]
// Modes: start (`nowaki start`), dev (`nowaki dev`), node (node adapter), cloudflare (the worker's
// fetch, called in Node), vercel (config.json routes + the function), static (prerender output).
// Server modes listen on --port (config A) and --port + 1 (config B). NOWAKI_BIN overrides the
// binary (default target/debug/nowaki).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4820;
const modes = args.filter((a, i) => !a.startsWith("--") && (portArg < 0 || i !== portArg + 1));
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const KNOWN = ["start", "dev", "node", "cloudflare", "vercel", "static"];
if (!modes.length || modes.some((m) => !KNOWN.includes(m))) {
  console.error(`usage: node scripts/rules-e2e.mjs <${KNOWN.join("|")}>... [--port 4820]`);
  process.exit(2);
}

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG_A = `export default {
  redirects: [
    { source: "/old/[...rest]", destination: "/new/[...rest]", permanent: true },
    { source: "/go/[to]", destination: "/[to]" },
    { source: "/legacy", destination: "/about" },
    { source: "/ext", destination: "https://example.com/landing", statusCode: 301 },
  ],
  rewrites: [
    { source: "/p/[id]", destination: "/photo/[id]" },
    { source: "/logo", destination: "/logo.txt" },
    { source: "/cached", destination: "/isr" },
  ],
  headers: [
    { source: "/", headers: { "x-rules": "on" } },
    { source: "/[...all]", headers: { "x-rules": "on" } },
    { source: "/api/[...rest]", headers: { "cache-control": "no-store", "x-frame-options": "DENY" } },
  ],
};
`;
const CONFIG_B = `export default {
  site: "https://e.x",
  basePath: "/app",
  trailingSlash: "never",
  redirects: [{ source: "/legacy", destination: "/about" }],
  rewrites: [{ source: "/p/[id]", destination: "/photo/[id]" }],
};
`;
const FILES = {
  "package.json": `{ "name": "rules-e2e", "private": true, "type": "module" }\n`,
  "routes/index.tsx": `export default function Home() { return <main>{"HOME"}</main>; }\n`,
  "routes/about.tsx": `export const meta = { canonical: true };
export const loader = (ctx) => ({ path: ctx.url.pathname });
export default function About({ data }) { return <main>{\`ABOUT url:\${data.path}\`}</main>; }\n`,
  "routes/secret.tsx": `export default function Secret() { return <main>{"SECRET_ROUTE"}</main>; }\n`,
  "routes/photo/[id].tsx": `export const loader = (ctx) => ({ id: ctx.params.id, path: ctx.url.pathname });
export const staticPaths = [{ id: "1" }];
export default function Photo({ data }) { return <main>{\`PHOTO id:\${data.id} url:\${data.path}\`}</main>; }\n`,
  "routes/new/[...rest].tsx": `export const loader = (ctx) => ({ rest: ctx.params.rest });
export const staticPaths = [{ rest: ["a", "b"] }];
export default function New({ data }) { return <main>{\`NEW rest:\${[data.rest].flat().join("+")}\`}</main>; }\n`,
  "routes/isr.tsx": `export const revalidate = 1;
let renders = 0;
export const loader = () => ({ n: ++renders });
export default function Isr({ data }) { return <main>{\`ISR render:\${data.n}\`}</main>; }\n`,
  "routes/api/own.ts": `export function GET() { return { status: 200, headers: { "cache-control": "max-age=7" }, body: { ok: true } }; }\n`,
  "routes/api/echo.ts": `export const csrf = false;
export function POST(ctx) { return { body: { path: ctx.url.pathname } }; }\n`,
  "public/logo.txt": "LOGO\n",
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-rules-e2e-"));
const children = new Set();
const cleanup = () => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

function makeApp(name, config) {
  const dir = path.join(tmp, name);
  for (const [file, text] of Object.entries({ ...FILES, "nowaki.config.mjs": config })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(dir, "node_modules"));
  return dir;
}

// Each package is linked to its real directory by an absolute junction. Linking the whole
// node_modules isn't enough on Windows: pnpm's entries are relative links, which `nowaki dev`
// can't follow through an outer junction (it reported the runtime missing).
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

// A request with the path sent verbatim: { status, headers, body }.
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

const offSite = (loc) => loc === undefined || /^\/\/|^\/\\/.test(loc);

async function checksA(label, req, { isr = false, assets = true } = {}) {
  const t = (s) => `${label} A: ${s}`;
  let r = await req("/old/a/b?x=1");
  check(t("redirect with the query (308)"), r.status === 308 && r.headers.location === "/new/a/b?x=1", `${r.status} ${r.headers.location}`);
  check(t("redirect carries the security headers and config headers"), r.headers["x-content-type-options"] === "nosniff" && r.headers["x-rules"] === "on");
  r = await req("/new/a/b");
  check(t("redirect target renders"), r.status === 200 && r.body.includes("NEW rest:a+b"), r.body.slice(0, 200));
  for (const [p, want] of [
    ["/go/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    ["/go/%5C%5Cevil.com", "/%5C%5Cevil.com"],
    ["/old//evil.com", "/new/evil.com"],
    ["/go/a%0D%0ASet-Cookie:%20pwned=1", "/a%0D%0ASet-Cookie%3A%20pwned%3D1"],
  ]) {
    r = await req(p);
    check(t(`open redirect ${p} → ${want}`), r.status >= 300 && r.status < 400 && r.headers.location === want && !offSite(r.headers.location) && !r.headers["set-cookie"], `${r.status} ${r.headers.location}`);
  }
  r = await req("/ext");
  check(t("external redirect (301)"), r.status === 301 && r.headers.location === "https://example.com/landing", `${r.status} ${r.headers.location}`);
  r = await req("/legacy", { method: "POST", headers: { "content-type": "text/plain" } });
  check(t("redirects apply to POST too (307)"), r.status === 307 && r.headers.location === "/about");
  r = await req("/p/42");
  check(t("rewrite renders the destination; ctx.url is the browser URL"), r.status === 200 && r.body.includes("PHOTO id:42 url:/p/42"), r.body.slice(0, 200));
  check(t("rewritten page gets config headers"), r.headers["x-rules"] === "on");
  r = await req("/logo");
  check(t("rewrite to a public/ file"), r.status === 200 && r.body.includes("LOGO"), `${r.status} ${r.body.slice(0, 80)}`);
  r = await req("/logo.txt");
  check(t("public file gets config headers"), r.status === 200 && r.headers["x-rules"] === "on");
  r = await req("/");
  check(t("config headers on / and the security defaults still there"), r.headers["x-rules"] === "on" && r.headers["x-frame-options"] === "SAMEORIGIN");
  r = await req("/api/own");
  check(t("a header the route set wins over the config"), r.headers["cache-control"] === "max-age=7", r.headers["cache-control"]);
  check(t("a config header wins over a security default"), r.headers["x-frame-options"] === "DENY", r.headers["x-frame-options"]);
  r = await req("/about/");
  check(t("trailingSlash ignore: both forms render; canonical keeps the request's"), r.status === 200 && /rel="canonical" href="[^"]*\/about\/"/.test(r.body), `${r.status} ${r.body.match(/rel="canonical"[^>]*/)?.[0]}`);
  r = await req("/nope");
  check(t("404 gets config headers"), r.status === 404 && r.headers["x-rules"] === "on");
  r = await req("/__nowaki/boundaries");
  check(t("framework endpoints: no rules, no config headers"), r.status === 200 && r.headers["x-rules"] === undefined);
  r = await req("/about", { headers: { "x-nowaki-route-path": "/secret" } });
  check(t("client x-nowaki-route-path is ignored"), r.status === 200 && r.body.includes("ABOUT url:/about") && !r.body.includes("SECRET_ROUTE"), r.body.slice(0, 200));
  r = await req("/nope", { headers: { "x-nowaki-route-path": "/secret" } });
  check(t("client x-nowaki-route-path can't turn a 404 into a page"), r.status === 404 && !r.body.includes("SECRET_ROUTE"));
  if (assets) {
    r = await req("/_nowaki/manifest.json");
    check(t("assets get config headers"), r.status === 200 && r.headers["x-rules"] === "on", String(r.status));
  }
  if (isr) {
    let first = await req("/cached");
    let second = await req("/cached");
    check(t("rewritten ISR page is cached under the browser path"), first.body.includes("ISR render:") && second.headers["x-nowaki-cache"] === "HIT", `${first.headers["x-nowaki-cache"]} ${second.headers["x-nowaki-cache"]}`);
    await sleep(1300);
    const stale = await req("/cached");
    await sleep(400);
    const fresh = await req("/cached");
    check(t("revalidation re-renders the rewrite's route"), stale.headers["x-nowaki-cache"] === "STALE" && fresh.headers["x-nowaki-cache"] === "HIT" && fresh.body.includes("ISR render:") && fresh.body !== second.body, `${stale.headers["x-nowaki-cache"]} ${fresh.headers["x-nowaki-cache"]} ${fresh.body.slice(0, 120)}`);
  }
}

async function checksB(label, req, { assets = true } = {}) {
  const t = (s) => `${label} B: ${s}`;
  let r = await req("/app");
  check(t("basePath root"), r.status === 200 && r.body.includes("HOME"), `${r.status}`);
  r = await req("/app/");
  check(t("trailing slash on basePath root → 308"), r.status === 308 && r.headers.location === "/app", `${r.status} ${r.headers.location}`);
  r = await req("/app/about");
  check(t("page under basePath; ctx.url keeps it"), r.status === 200 && r.body.includes("ABOUT url:/app/about"), r.body.slice(0, 200));
  check(t("trailingSlash never: canonical without the slash"), /rel="canonical" href="https:\/\/e\.x[^"]*\/about"/.test(r.body), r.body.match(/rel="canonical"[^>]*/)?.[0]);
  r = await req("/app/sitemap.xml");
  check(t("trailingSlash never: sitemap URLs without the slash"), r.status === 200 && /<loc>https:\/\/e\.x[^<]*\/about<\/loc>/.test(r.body), `${r.status} ${r.body.slice(0, 300)}`);
  r = await req("/app/about/?q=1");
  check(t("trailingSlash never → 308 with the query"), r.status === 308 && r.headers.location === "/app/about?q=1", `${r.status} ${r.headers.location}`);
  r = await req("/about");
  check(t("outside basePath → 404"), r.status === 404, `${r.status}`);
  r = await req("/app/legacy");
  check(t("redirect gets basePath"), r.status === 307 && r.headers.location === "/app/about", `${r.status} ${r.headers.location}`);
  r = await req("/app/p/3");
  check(t("rewrite under basePath"), r.status === 200 && r.body.includes("PHOTO id:3 url:/app/p/3"), r.body.slice(0, 200));
  r = await req("/app/logo.txt");
  check(t("public file under basePath"), r.status === 200 && r.body.includes("LOGO"), `${r.status}`);
  r = await req("/app/api/echo/", { method: "POST", headers: { "content-type": "application/json" } });
  check(t("POST with a trailing slash isn't redirected"), r.status === 200 && r.body.includes('"/app/api/echo/"'), `${r.status} ${r.body.slice(0, 100)}`);
  r = await req("/__nowaki/boundaries");
  check(t("framework endpoints stay at the root"), r.status === 200, `${r.status}`);
  r = await req("/app/about", { headers: { "x-nowaki-route-path": "/secret" } });
  check(t("client x-nowaki-route-path is ignored"), r.body.includes("ABOUT url:/app/about") && !r.body.includes("SECRET_ROUTE"));
  if (assets) {
    r = await req("/_nowaki/manifest.json");
    check(t("assets stay at the root"), r.status === 200, `${r.status}`);
  }
}

const appA = makeApp("a", CONFIG_A);
const appB = makeApp("b", CONFIG_B);

try {
  for (const mode of modes) {
    console.log(`\n--- ${mode} ---`);
    if (mode === "start") {
      build(appA);
      build(appB);
      const env = { ...process.env, NOWAKI_ISR_WARM: "0" };
      const stopA = await serve(BIN, ["start", appA, "--port", String(PORT)], { env }, PORT);
      const stopB = await serve(BIN, ["start", appB, "--port", String(PORT + 1)], { env }, PORT + 1);
      await checksA("start", httpClient(PORT), { isr: true });
      await checksB("start", httpClient(PORT + 1));
      stopA();
      stopB();
    } else if (mode === "dev") {
      const stopA = await serve(BIN, ["dev", appA, "--port", String(PORT)], {}, PORT);
      const stopB = await serve(BIN, ["dev", appB, "--port", String(PORT + 1)], {}, PORT + 1);
      const reqA = httpClient(PORT);
      await checksA("dev", reqA, { assets: false });
      const mod = await reqA("/routes/about.tsx");
      check("dev A: app modules are served ahead of the rules", mod.status === 200 && /javascript/.test(mod.headers["content-type"] ?? ""));
      await checksB("dev", httpClient(PORT + 1), { assets: false });
      const rt = await httpClient(PORT + 1)("/node_modules/@nowaki-dev/runtime/client/router.js");
      check("dev B: the runtime is served at the root under basePath", rt.status === 200, `${rt.status}`);
      stopA();
      stopB();
    } else if (mode === "node") {
      build(appA, "node");
      build(appB, "node");
      const stopA = await serve("node", [path.join(appA, "dist/server/index.mjs")], { env: { ...process.env, PORT: String(PORT), NOWAKI_HOST: "127.0.0.1" } }, PORT);
      const stopB = await serve("node", [path.join(appB, "dist/server/index.mjs")], { env: { ...process.env, PORT: String(PORT + 1), NOWAKI_HOST: "127.0.0.1" } }, PORT + 1);
      await checksA("node", httpClient(PORT));
      await checksB("node", httpClient(PORT + 1));
      stopA();
      stopB();
    } else if (mode === "cloudflare") {
      for (const [dir, run] of [[appA, checksA], [appB, checksB]]) {
        build(dir, "cloudflare");
        const workerDir = path.join(dir, "dist/worker");
        const src = readFileSync(path.join(workerDir, "index.js"), "utf8");
        check(`cloudflare ${dir === appA ? "A" : "B"}: the worker inlines the rules`, src.includes("compileRules(") && src.includes("frontStep("));
        const worker = (await import(pathToFileURL(path.join(workerDir, "index.js")).href)).default;
        // The Assets binding, served from dist/worker/assets by the request's path.
        const ASSETS = {
          fetch: async (request) => {
            const file = path.join(workerDir, "assets", decodeURIComponent(new URL(request.url).pathname));
            return existsSync(file) && !file.endsWith(path.sep) ? new Response(readFileSync(file), { headers: { "content-type": "text/plain" } }) : new Response("missing", { status: 404 });
          },
        };
        const req = async (p, init = {}) => {
          const res = await worker.fetch(new Request(`https://app.example${p}`, { redirect: "manual", ...init }), { ASSETS });
          return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
        };
        await run("cloudflare", req);
      }
    } else if (mode === "vercel") {
      build(appA, "vercel");
      const config = JSON.parse(readFileSync(path.join(appA, ".vercel/output/config.json"), "utf8"));
      const fsIndex = config.routes.findIndex((r) => r.handle === "filesystem");
      const before = config.routes.slice(0, fsIndex);
      const loc = (l) => before.find((r) => r.headers?.Location === l);
      check("vercel: /old/[...rest] is a platform redirect before the filesystem", loc("/new/$n0")?.status === 308);
      check("vercel: /go/[to] is a platform redirect", loc("/$n0")?.status === 307);
      check("vercel: external redirect", loc("https://example.com/landing")?.status === 301);
      check("vercel: config headers are platform routes", before.some((r) => r.continue && r.headers?.["cache-control"] === "no-store" && new RegExp(r.src).test("/api/x")));
      const goRoute = loc("/$n0");
      check("vercel: an encoded slash never matches a platform redirect", goRoute && !new RegExp(goRoute.src).test("/go/%2F%2Fevil.com") && !new RegExp(goRoute.src).test("/go///evil.com"));
      const funcDir = path.join(appA, ".vercel/output/functions/index.func");
      const stop = await serve("node", ["-e", `import(${JSON.stringify(pathToFileURL(path.join(funcDir, "index.mjs")).href)}).then(m=>require("http").createServer(m.default).listen(${PORT}, "127.0.0.1"))`], { cwd: funcDir }, PORT);
      await checksA("vercel function", httpClient(PORT), { assets: false });
      stop();
    } else if (mode === "static") {
      const outA = build(appA, "static");
      const redirects = readFileSync(path.join(appA, "dist/static/_redirects"), "utf8");
      const headers = readFileSync(path.join(appA, "dist/static/_headers"), "utf8");
      check("static A: _redirects", redirects.includes("/old/* /new/:splat 308\n") && redirects.includes("/go/:to /:to 307\n") && redirects.includes("/p/:id /photo/:id 200\n") && redirects.includes("/ext https://example.com/landing 301\n"), redirects);
      check("static A: _headers has the config headers after the defaults", /\/api\/\*\n {2}cache-control: no-store\n/.test(headers) && headers.indexOf("/api/*") > headers.indexOf("x-content-type-options"), headers);
      check("static A: warns about a header a host may merge", /x-frame-options/.test(outA));
      check("static A: pages rendered", readFileSync(path.join(appA, "dist/static/photo/1/index.html"), "utf8").includes("PHOTO id:1"));
      check("static A: trailingSlash ignore: x/index.html with a canonical slash", /rel="canonical" href="[^"]*\/about\/"/.test(readFileSync(path.join(appA, "dist/static/about/index.html"), "utf8")));
      const outB = build(appB, "static");
      const staticB = (f) => path.join(appB, "dist/static", f);
      const aboutB = existsSync(staticB("about.html")) ? readFileSync(staticB("about.html"), "utf8") : "";
      check("static B: pages requested under basePath", aboutB.includes("ABOUT url:/app/about"));
      check("static B: trailingSlash never writes x.html", !existsSync(staticB("about/index.html")) && existsSync(staticB("photo/1.html")) && existsSync(staticB("new/a/b.html")) && existsSync(staticB("index.html")));
      check("static B: canonical without the slash", /rel="canonical" href="https:\/\/e\.x[^"]*\/about"/.test(aboutB), aboutB.match(/rel="canonical"[^>]*/)?.[0]);
      const sitemapB = existsSync(staticB("sitemap.xml")) ? readFileSync(staticB("sitemap.xml"), "utf8") : "";
      check("static B: sitemap URLs without the slash", /<loc>https:\/\/e\.x[^<]*\/photo\/1<\/loc>/.test(sitemapB) && !/\/<\/loc>/.test(sitemapB.replace(/<loc>https:\/\/e\.x(\/app)?\/?<\/loc>/, "")), sitemapB);
      check("static B: _redirects carries basePath", readFileSync(path.join(appB, "dist/static/_redirects"), "utf8").includes("/app/legacy /app/about 307\n"));
      check("static B: warns about basePath, not trailingSlash (the file layout carries it)", /basePath/.test(outB) && !/trailingSlash/.test(outB));
    }
  }
} catch (e) {
  console.error(e);
  failed++;
}

console.log(failed ? `\nRULES E2E FAILED (${failed})` : "\nRULES E2E PASSED");
process.exit(failed ? 1 : 0);
