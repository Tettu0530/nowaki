// CDN purge per adapter (server/purge-vercel.mjs, app.mjs `cdn`, vercel-build.mjs): the
// Vercel-Cache-Tag encoding, the header on ISR pages only, the purge awaited before an action's
// response, the 2 s timeout, the warn-once without @vercel/functions, and a generated Vercel
// function (mocked @vercel/functions copied in with its dependency) answering real requests.
// No network: the package is a local fake. Listens on 127.0.0.1:5540.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import * as R from "../packages/nowaki-runtime/server/revalidate.mjs";
import { VERCEL_TAG_HEADER, cdnTag, vercelCdn } from "../packages/nowaki-runtime/server/purge-vercel.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(root, "packages/nowaki-runtime");
const { h } = createRequire(path.join(runtimeDir, "server/handler.mjs"))("preact");
const PORT = 5540;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));
const warned = (re) => warnings.filter((w) => re.test(w)).length;

// --- tag encoding -------------------------------------------------------------------------------
const VISIBLE = /^[\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]+$/; // % stays: it is the escape
check("a plain entry is its own tag", cdnTag("t:posts") === "t:posts" && cdnTag("p:/blog/hello") === "p:/blog/hello");
check("case is kept (Vercel tags are case sensitive)", cdnTag("t:Posts") !== cdnTag("t:posts"));
check("quotes, backslashes, % and non-ASCII are percent-encoded", cdnTag('t:a"b\\c%d\u00e9') === "t:a%22b%5Cc%25d%C3%A9", cdnTag('t:a"b\\c%d\u00e9'));
const long = `t:${"x".repeat(255)}`;
check("a tag over 256 bytes becomes h:<hash>", /^h:[0-9a-f]{16}$/.test(cdnTag(long)), cdnTag(long));
check("the hash is stable and tells inputs apart", cdnTag(long) === cdnTag(long) && cdnTag(long) !== cdnTag(`${long}y`));
check("a 256-character tag stays as is", cdnTag(`t:${"x".repeat(254)}`).length === 256);
const multi = `t:${"\u00e9".repeat(100)}`; // 100 characters, 600 encoded
check("multibyte tags are measured encoded", cdnTag(multi).startsWith("h:"));
const samples = ["t:posts", 'p:/a"b', `p:/${"%E3%81%82".repeat(40)}`, multi, long, "t:\u{1F600}"].map((e) => cdnTag(e));
check("every tag fits Vercel's rules (visible ASCII, no comma / quote / backslash, <= 256)", samples.every((t) => VISIBLE.test(t) && t.length <= 256), JSON.stringify(samples));

// --- vercelCdn with a mocked @vercel/functions ----------------------------------------------------
process.env.VERCEL = "1";
const calls = [];
const mock = (impl) => vercelCdn({ load: async () => ({ dangerouslyDeleteByTag: impl }), timeoutMs: 100 });
const recording = mock(async (tags, opts) => {
  calls.push({ tags, opts });
});
check("cacheTagHeader builds Vercel-Cache-Tag", same(recording.cacheTagHeader(["t:posts", "p:/blog"]), { [VERCEL_TAG_HEADER]: "t:posts,p:/blog" }));
check("cacheTagHeader of nothing is null", recording.cacheTagHeader([]) === null);
check("the header name is vercel-cache-tag", VERCEL_TAG_HEADER === "vercel-cache-tag");
await recording.purge(["t:posts", "p:/blog", "p:/blog/", "t:posts", long]);
check("purge deletes the same tags the header carries (deduplicated)", same(calls[0]?.tags, ["t:posts", "p:/blog", "p:/blog/", cdnTag(long)]), JSON.stringify(calls));
check("purge deletes now (no revalidation deadline)", calls[0] && calls[0].opts === undefined);
calls.length = 0;
await recording.purge(Array.from({ length: 40 }, (_, i) => `t:t${i}`));
check("purge sends at most 16 tags per call", same(calls.map((c) => c.tags.length), [16, 16, 8]));

const hanging = mock(() => new Promise(() => {}));
let t0 = Date.now();
await hanging.purge(["t:slow"]);
const took = Date.now() - t0;
check("a purge that hangs is given up after the timeout", took >= 90 && took < 1000, `${took} ms`);
check("the timeout is logged", warned(/did not finish within 100 ms/) === 1);
check("the default timeout is 2 s", /timeoutMs = TIMEOUT_MS/.test(readFileSync(path.join(runtimeDir, "server/purge-vercel.mjs"), "utf8")) && /TIMEOUT_MS = 2000/.test(readFileSync(path.join(runtimeDir, "server/purge-vercel.mjs"), "utf8")));

let loads = 0;
const missing = vercelCdn({
  load: async () => {
    loads++;
    const err = new Error("Cannot find package '@vercel/functions'");
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  },
});
await missing.purge(["t:a"]);
await missing.purge(["t:b"]);
check("without @vercel/functions a purge warns once", warned(/add @vercel\/functions/) === 1, JSON.stringify(warnings));
check("the missing package is looked up once", loads === 1);
check("the header is still emitted without the package", same(missing.cacheTagHeader(["t:a"]), { [VERCEL_TAG_HEADER]: "t:a" }));

const failing = mock(async () => {
  throw new Error("429 Too Many Requests");
});
let rejected = null;
await failing.purge(["t:a"]).catch((e) => (rejected = e));
check("a failed purge rejects (revalidate.mjs logs it)", rejected?.message === "429 Too Many Requests");

delete process.env.VERCEL;
await mock(async () => {}).purge(["t:a"]);
check("off Vercel a purge warns once", warned(/not running on Vercel/) === 1);
process.env.VERCEL = "1";

// --- through the request handler ------------------------------------------------------------------
const order = [];
const cdn = vercelCdn({
  load: async () => ({
    dangerouslyDeleteByTag: async (tags) => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(`purged ${tags.join(",")}`);
    },
  }),
});
const modules = {
  "routes/tagged.tsx": { revalidate: 60, tags: ["posts"], default: () => h("p", null, "tagged") },
  "routes/isr.tsx": { revalidate: 60, default: () => h("p", null, "isr") },
  "routes/plain.tsx": { default: () => h("p", null, "plain") },
  "routes/save.tsx": {
    action: (ctx) => {
      R.revalidateTag("posts");
      R.revalidatePath("/isr");
      return ctx.redirect("/tagged", 303);
    },
    default: () => h("p", null, "form"),
  },
  "routes/quiet.tsx": { action: (ctx) => ctx.redirect("/plain", 303), default: () => h("p", null, "quiet") },
};
const table = {
  routes: Object.keys(modules).map((file) => ({ file, segments: [{ lit: file.slice(7, -4) }], dir: "", isApi: false })),
  layouts: [],
  middleware: [],
};
const env = {
  routeTable: async () => table,
  importModule: async (file) => modules[file],
  ensureIslands: async () => {},
  renderDocument: ({ body }) => body,
  renderError: (err) => ({ status: 500, headers: {}, body: String(err) }),
  onError: () => {},
  trailingSlash: "ignore",
  purge: cdn.purge,
  cacheTagHeader: cdn.cacheTagHeader,
};
R.setRevalidateEnv(env);
const req = (p, { method = "GET", body } = {}) =>
  handleRequest(env, {
    method,
    url: new URL(`http://x.test${p}`),
    headers: method === "POST" ? { host: "x.test", origin: "http://x.test", "content-type": "application/x-www-form-urlencoded" } : { host: "x.test" },
    readBody: async () => new TextEncoder().encode(body ?? ""),
    version: 1,
  });
{
  const r = await req("/tagged");
  check("an ISR page with tags carries its tags and its path", r.headers[VERCEL_TAG_HEADER] === "t:posts,p:/tagged", JSON.stringify(r.headers));
  const q = await req("/tagged?page=2");
  check("a query variant carries the same path tag", q.headers[VERCEL_TAG_HEADER] === "t:posts,p:/tagged");
  const i = await req("/isr");
  check("an ISR page without tags carries its path tag", i.headers[VERCEL_TAG_HEADER] === "p:/isr");
  const p = await req("/plain");
  check("a page without revalidate carries no tag header", p.headers[VERCEL_TAG_HEADER] === undefined);
  check("no x-nowaki-tags off nowaki start", r.headers["x-nowaki-tags"] === undefined && r.headers["x-nowaki-purge"] === undefined);
}
{
  const res = await req("/save", { method: "POST", body: "x=1" });
  order.push("response");
  check("the action still redirects", res.status === 303);
  check("the purge finished before the action's response", same(order, ["purged t:posts,p:/isr,p:/isr/", "response"]), JSON.stringify(order));
  check("revalidatePath purges the path tags the pages carry", order[0].includes("p:/isr"));
  order.length = 0;
  const quiet = await req("/quiet", { method: "POST", body: "x=1" });
  check("an action without revalidate calls purges nothing", quiet.status === 303 && order.length === 0);
}

// --- the generated Vercel function ---------------------------------------------------------------
const work = mkdtempSync(path.join(tmpdir(), "nowaki-purge-"));
try {
  const app = path.join(work, "app");
  const nm = path.join(app, "node_modules");
  mkdirSync(path.join(nm, "@nowaki-dev"), { recursive: true });
  symlinkSync(runtimeDir, path.join(nm, "@nowaki-dev/runtime"), "dir");
  for (const dep of ["preact", "preact-render-to-string"]) symlinkSync(path.join(runtimeDir, "node_modules", dep), path.join(nm, dep), "dir");
  // A fake @vercel/functions (CommonJS, like the real one) with a dependency, nested pnpm-style.
  const store = path.join(nm, ".store/node_modules");
  const fake = path.join(store, "@vercel/functions");
  mkdirSync(fake, { recursive: true });
  writeFileSync(path.join(fake, "package.json"), JSON.stringify({ name: "@vercel/functions", version: "3.11.1", main: "index.js", dependencies: { "@vercel/oidc": "4.0.8" } }));
  writeFileSync(
    path.join(fake, "index.js"),
    `require("@vercel/oidc");\nexports.dangerouslyDeleteByTag = async (tags, opts) => { (globalThis.__nowakiPurged ??= []).push(tags); };\n`,
  );
  mkdirSync(path.join(store, "@vercel/oidc"), { recursive: true });
  writeFileSync(path.join(store, "@vercel/oidc/package.json"), JSON.stringify({ name: "@vercel/oidc", version: "4.0.8", main: "index.js" }));
  writeFileSync(path.join(store, "@vercel/oidc/index.js"), "exports.ok = true;\n");
  mkdirSync(path.join(nm, "@vercel"), { recursive: true });
  symlinkSync(fake, path.join(nm, "@vercel/functions"), "dir");

  const dist = path.join(app, "dist");
  mkdirSync(path.join(dist, "server/routes"), { recursive: true });
  mkdirSync(path.join(dist, "client"), { recursive: true });
  writeFileSync(path.join(dist, "client/manifest.json"), "{}");
  writeFileSync(
    path.join(dist, "server/routes/isr.js"),
    `import { h } from "preact";
import { revalidatePath, revalidateTag } from "@nowaki-dev/runtime";
export const revalidate = 60;
export const tags = ["posts"];
export async function action(ctx) {
  revalidateTag("posts");
  revalidatePath("/isr");
  return ctx.redirect("/isr", 303);
}
export default () => h("p", null, "isr");
`,
  );
  writeFileSync(path.join(dist, "server/routes/index.js"), `import { h } from "preact";\nexport default () => h("p", null, "home");\n`);
  const out = path.join(app, ".vercel/output");
  const log = execFileSync(process.execPath, [path.join(runtimeDir, "server/vercel-build.mjs"), path.join(dist, "server"), path.join(dist, "client"), out, app], { encoding: "utf8" });
  const func = path.join(out, "functions/index.func");
  check("vercel-build copies @vercel/functions into the function", existsSync(path.join(func, "node_modules/@vercel/functions/index.js")));
  check("...with its dependencies, flat", existsSync(path.join(func, "node_modules/@vercel/oidc/index.js")));
  check("vercel-build says the purge is on", /@vercel\/functions included/.test(log), log);
  check("the function wires vercelCdn", readFileSync(path.join(func, "index.mjs"), "utf8").includes("cdn: vercelCdn()"));

  const { default: handle } = await import(pathToFileURL(path.join(func, "index.mjs")).href);
  const server = createServer(handle);
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${PORT}`;
    const isr = await fetch(`${base}/isr`);
    check("the function's ISR page sends Vercel-Cache-Tag", isr.headers.get(VERCEL_TAG_HEADER) === "t:posts,p:/isr", String(isr.headers.get(VERCEL_TAG_HEADER)));
    check("...next to its shared cache-control", /s-maxage=60/.test(isr.headers.get("cache-control") ?? ""));
    const home = await fetch(`${base}/`);
    check("a page without revalidate sends no Vercel-Cache-Tag", home.status === 200 && !home.headers.has(VERCEL_TAG_HEADER));
    const saved = await fetch(`${base}/isr`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: "x=1",
    });
    check("the function's action redirects", saved.status === 303, String(saved.status));
    check("...after deleting the tags through @vercel/functions", same(globalThis.__nowakiPurged, [["t:posts", "p:/isr", "p:/isr/"]]), JSON.stringify(globalThis.__nowakiPurged));
  } finally {
    await new Promise((r) => server.close(r));
  }

  // Without the package: the build says so and the function has none.
  rmSync(path.join(nm, "@vercel"), { recursive: true });
  const log2 = execFileSync(process.execPath, [path.join(runtimeDir, "server/vercel-build.mjs"), path.join(dist, "server"), path.join(dist, "client"), out, app], { encoding: "utf8" });
  check("without @vercel/functions the build says purges are off", /no @vercel\/functions in the app/.test(log2), log2);
  check("...and copies nothing", !existsSync(path.join(func, "node_modules/@vercel")));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.warn = origWarn;
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall purge adapter checks passed");
process.exit(0);
