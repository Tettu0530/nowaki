// Unit checks for on-demand revalidation (server/revalidate.mjs + handler.mjs): the purge encoding
// and path expansion (shared fixture with start.rs), tags on ISR responses, purges riding on the
// response of an action / API route / server function, env.purge / env.cacheTagHeader seams, the
// stdout channel outside a request, dev recording, and POST /__nowaki/revalidate. No server needed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { compileI18n } from "../packages/nowaki-runtime/server/i18n.mjs";
import { getContext, runWithContext } from "../packages/nowaki-runtime/server/functions.mjs";
import { setBasePath } from "../packages/nowaki-runtime/server/base-path.mjs";
import * as R from "../packages/nowaki-runtime/server/revalidate.mjs";
import * as index from "../packages/nowaki-runtime/index.js";

const { h } = createRequire(new URL("../packages/nowaki-runtime/server/handler.mjs", import.meta.url))("preact");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- the shared fixture -------------------------------------------------------------------------
const fx = JSON.parse(readFileSync(new URL("../crates/nowaki/tests/fixtures/purge-cases.json", import.meta.url), "utf8"));
for (const c of fx.encode) {
  check(`encode ${JSON.stringify(c.entries)}`, R.encodeEntries(c.entries) === c.header, R.encodeEntries(c.entries));
  check(`decode ${c.header}`, same(R.decodeEntries(c.header), c.entries));
}
for (const c of fx.broken) check(`broken items are dropped: ${c.header}`, same(R.decodeEntries(c.header), c.entries), JSON.stringify(R.decodeEntries(c.header)));
for (const c of fx.expand) {
  const cfg = fx.configs[c.config];
  const got = R.expandPath(c.path, { base: cfg.basePath ?? "", trailingSlash: cfg.trailingSlash, i18n: compileI18n(cfg) });
  check(`expand ${c.path} (${c.config})`, same(got, c.paths), JSON.stringify(got));
}
check("valid tags", fx.validTags.every(R.validTag));
check("invalid tags", !fx.invalidTags.some(R.validTag) && !R.validTag("x".repeat(257)) && R.validTag("x".repeat(256)));
check("valid paths", fx.validPaths.every(R.validPath));
check("invalid paths", !fx.invalidPaths.some(R.validPath) && !R.validPath(42));
check("revalidatePath / revalidateTag are exported from the package", index.revalidatePath === R.revalidatePath && index.revalidateTag === R.revalidateTag);
let threw = 0;
for (const f of [() => R.revalidateTag("a b"), () => R.revalidateTag(""), () => R.revalidatePath("blog"), () => R.revalidatePath("//evil.test")]) {
  try {
    f();
  } catch (err) {
    if (err instanceof TypeError) threw++;
  }
}
check("invalid arguments throw a TypeError", threw === 4);

// --- capture console.warn and stdout ------------------------------------------------------------
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));
const lines = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = String(chunk);
  if (s.startsWith("NOWAKI_PURGE ")) {
    lines.push(s);
    return true;
  }
  return origWrite(chunk, ...rest);
};
process.env.NOWAKI_PUBLISH_TOKEN = "tok123";
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- an in-memory app -----------------------------------------------------------------------------
const purged = [];
const modules = {
  "routes/tagged.tsx": { revalidate: 60, tags: ["posts", "bad tag"], default: () => h("p", null, "tagged") },
  "routes/post/[slug].tsx": {
    revalidate: 60,
    tags: ({ params, data }) => ["posts", `post:${params.slug}`, data.extra],
    loader: () => ({ extra: "x:1" }),
    default: () => h("p", null, "post"),
  },
  "routes/plain.tsx": { revalidate: 60, default: () => h("p", null, "plain") },
  "routes/save.tsx": {
    action: (ctx) => {
      R.revalidateTag("posts");
      R.revalidatePath("/blog");
      return ctx.redirect("/blog");
    },
    default: () => h("p", null, "form"),
  },
  "routes/api/touch.ts": {
    POST: () => {
      R.revalidatePath("/about");
      return { ctx: getContext() !== null };
    },
  },
  "routes/api/many.ts": {
    POST: () => {
      for (let i = 0; i < 600; i++) R.revalidateTag(`tag-${"x".repeat(20)}-${i}`);
      return { ok: true };
    },
  },
};
const table = {
  routes: [
    { file: "routes/tagged.tsx", segments: [{ lit: "tagged" }], dir: "", isApi: false },
    { file: "routes/post/[slug].tsx", segments: [{ lit: "post" }, { param: "slug" }], dir: "/post", isApi: false },
    { file: "routes/plain.tsx", segments: [{ lit: "plain" }], dir: "", isApi: false },
    { file: "routes/save.tsx", segments: [{ lit: "save" }], dir: "", isApi: false },
    { file: "routes/api/touch.ts", segments: [{ lit: "api" }, { lit: "touch" }], dir: "/api", isApi: true },
    { file: "routes/api/many.ts", segments: [{ lit: "api" }, { lit: "many" }], dir: "/api", isApi: true },
  ],
  layouts: [],
  middleware: [],
};
const makeEnv = (extra = {}) => ({
  routeTable: async () => table,
  importModule: async (file) => modules[file],
  ensureIslands: async () => {},
  renderDocument: ({ body }) => body,
  renderError: (err) => ({ status: 500, headers: {}, body: String(err) }),
  onError: () => {},
  ...extra,
});
const req = (env, path, { method = "GET", headers = {}, body } = {}) =>
  handleRequest(env, {
    method,
    url: new URL(`http://x.test${path}`),
    headers: { host: "x.test", ...headers },
    readBody: async () => new TextEncoder().encode(body ?? ""),
    version: 1,
  });
const post = (env, path, opts = {}) => req(env, path, { method: "POST", ...opts, headers: { origin: "http://x.test", ...opts.headers } });

// --- nowaki start (env.isrStore) ----------------------------------------------------------------
const start = makeEnv({ isrStore: true, trailingSlash: "ignore" });
R.setRevalidateEnv(start);
{
  const r = await req(start, "/tagged");
  check("ISR page: static tags go out as x-nowaki-tags (invalid ones dropped)", r.headers["x-nowaki-tags"] === "posts", r.headers["x-nowaki-tags"]);
  check("an invalid static tag is warned about", warnings.some((w) => w.includes("bad tag")));
  const again = await req(start, "/tagged");
  check("static tags are computed once per module", again.headers["x-nowaki-tags"] === "posts");
  const p = await req(start, "/post/caf%C3%A9");
  check("tags as a function of { params, data }", p.headers["x-nowaki-tags"] === "posts,post:caf%C3%A9,x:1", p.headers["x-nowaki-tags"]);
  const plain = await req(start, "/plain");
  check("an ISR page without tags sends no x-nowaki-tags", !("x-nowaki-tags" in plain.headers));
  check("a GET page carries no purge", !("x-nowaki-purge" in plain.headers));

  const saved = await post(start, "/save");
  check("action: a redirect", saved.status === 302 || saved.status === 303, String(saved.status));
  const entries = R.decodeEntries(saved.headers["x-nowaki-purge"]);
  check("action: revalidateTag + revalidatePath ride on the response", same(entries, ["t:posts", "p:/blog", "p:/blog/"]), JSON.stringify(entries));

  const api = await post(start, "/api/touch", { headers: { "content-type": "application/json" } });
  check("API route: getContext() works", JSON.parse(api.body).ctx === true);
  check("API route: the purge rides on the response", same(R.decodeEntries(api.headers["x-nowaki-purge"]), ["p:/about", "p:/about/"]));

  lines.length = 0;
  const many = await post(start, "/api/many");
  const header = many.headers["x-nowaki-purge"];
  const overflow = lines.flatMap((l) => R.decodeEntries(l.trim().split(" ")[2]));
  check("over 8 KB: the header is capped", header.length <= 8192, String(header.length));
  check("over 8 KB: the rest goes through stdout with the token", lines.every((l) => l.startsWith("NOWAKI_PURGE tok123 ")) && R.decodeEntries(header).length + overflow.length === 600, `${R.decodeEntries(header).length}+${overflow.length}`);

  lines.length = 0;
  R.revalidateTag("a");
  R.revalidateTag("b");
  R.revalidatePath("/x");
  check("outside a request nothing is written synchronously", lines.length === 0);
  await tick();
  check("outside a request: one batched stdout line", lines.length === 1 && lines[0] === "NOWAKI_PURGE tok123 t:a,t:b,p:/x,p:/x/\n", JSON.stringify(lines));

  // A live render over WebSocket has a context but no response.
  lines.length = 0;
  const liveCtx = {};
  runWithContext(liveCtx, () => R.revalidateTag("live"));
  R.flushDetached(liveCtx);
  check("flushDetached sends a context's purge through stdout", lines.length === 1 && lines[0].includes("t:live") && liveCtx.__purge === undefined);
}

// --- basePath + i18n expansion through the env ----------------------------------------------------
{
  setBasePath("/app");
  const env = makeEnv({ isrStore: true, trailingSlash: "always", i18n: compileI18n({ i18n: { locales: ["en", "fr"], defaultLocale: "en" }, basePath: "/app", trailingSlash: "always" }) });
  R.setRevalidateEnv(env);
  const ctx = {};
  runWithContext(ctx, () => R.revalidatePath("/fr/about?x=1"));
  check("revalidatePath expands to every locale under the base", same([...ctx.__purge], ["p:/app/about/", "p:/app/fr/about/"]), JSON.stringify([...ctx.__purge]));
  setBasePath("");
}

// --- adapter seams: env.purge and env.cacheTagHeader ------------------------------------------------
{
  let resolved = false;
  const seen = [];
  const env = makeEnv({
    purge: async (entries) => {
      await tick();
      purged.push(entries);
      resolved = true;
    },
    cacheTagHeader: (entries) => (seen.push(entries), { "cache-tag": entries.join(",") }),
  });
  R.setRevalidateEnv(env);
  const page = await req(env, "/tagged");
  check("cacheTagHeader gets the route's tags and the page's path", same(seen[0], ["t:posts", "p:/tagged"]) && page.headers["cache-tag"] === "t:posts,p:/tagged", JSON.stringify(seen));
  check("adapters get no x-nowaki-tags", !("x-nowaki-tags" in page.headers));
  await req(env, "/plain");
  check("cacheTagHeader for a page without tags: just its path", same(seen[1], ["p:/plain"]));
  const saved = await post(env, "/save");
  check("env.purge is awaited before the response returns", resolved && same(purged.at(-1), ["t:posts", "p:/blog", "p:/blog/"]));
  check("adapters get no x-nowaki-purge header", !("x-nowaki-purge" in saved.headers));
}

// --- dev, static output, nothing to purge ---------------------------------------------------------------
{
  const dev = makeEnv({ dev: true });
  R.setRevalidateEnv(dev);
  warnings.length = 0;
  const saved = await post(dev, "/save");
  check("dev: no purge header", !("x-nowaki-purge" in saved.headers));
  const recent = R.recentRevalidations();
  check("dev: calls are recorded for the dev tools", recent.length === 2 && recent[0].call === 'revalidateTag("posts")' && same(recent[1].entries, ["p:/blog", "p:/blog/"]), JSON.stringify(recent));
  await post(dev, "/save");
  check("dev: logged once", warnings.filter((w) => w.includes("nowaki dev")).length === 1);

  R.setRevalidateEnv(makeEnv({ staticOutput: true, isrStore: true }));
  lines.length = 0;
  R.revalidateTag("s");
  await tick();
  check("static output: a no-op with a warning", lines.length === 0 && warnings.some((w) => w.includes("static output")));

  const node = makeEnv({});
  R.setRevalidateEnv(node);
  const res = await post(node, "/save");
  check("no ISR store: a no-op with a warning", !("x-nowaki-purge" in res.headers) && warnings.some((w) => w.includes("only `nowaki start`")));
}

// --- POST /__nowaki/revalidate ---------------------------------------------------------------------
{
  const env = makeEnv({ isrStore: true });
  R.setRevalidateEnv(env);
  delete process.env.NOWAKI_REVALIDATE_SECRET;
  const off = await post(env, "/__nowaki/revalidate", { headers: { authorization: "Bearer x", "content-type": "application/json" }, body: '{"tags":["a"]}' });
  check("endpoint: off without NOWAKI_REVALIDATE_SECRET (a 404)", off.status === 404, String(off.status));

  process.env.NOWAKI_REVALIDATE_SECRET = "s3cret-s3cret-s3cret";
  const call = (headers, body, method = "POST") =>
    req(env, "/__nowaki/revalidate", { method, headers: { "content-type": "application/json", ...headers }, body });
  const auth = { authorization: "Bearer s3cret-s3cret-s3cret" };
  check("endpoint: GET is 405", (await call(auth, "", "GET")).status === 405);
  check("endpoint: no secret is 401", (await call({}, '{"tags":["a"]}')).status === 401);
  check("endpoint: a wrong secret is 401", (await call({ authorization: "Bearer s3cret" }, '{"tags":["a"]}')).status === 401);
  check("endpoint: a non-JSON body type is 415", (await call({ ...auth, "content-type": "text/plain" }, '{"tags":["a"]}')).status === 415);
  check("endpoint: bad JSON is 400", (await call(auth, "{")).status === 400);
  check("endpoint: an empty request is 400", (await call(auth, "{}")).status === 400);
  check("endpoint: an invalid tag is 400", (await call(auth, '{"tags":["a b"]}')).status === 400);
  check("endpoint: an invalid path is 400", (await call(auth, '{"paths":["//x"]}')).status === 400);
  check("endpoint: too large is 413", (await call(auth, JSON.stringify({ tags: ["x".repeat(70000)] }))).status === 413);
  const ok = await call(auth, '{"paths":["/blog"],"tags":["posts"]}');
  check("endpoint: 200 with the purge on the response", ok.status === 200 && same(R.decodeEntries(ok.headers["x-nowaki-purge"]), ["p:/blog", "p:/blog/", "t:posts"]), `${ok.status} ${ok.headers["x-nowaki-purge"]}`);
  check("endpoint: not cacheable", ok.headers["cache-control"] === "no-store");
  delete process.env.NOWAKI_REVALIDATE_SECRET;
}

console.warn = origWarn;
process.stdout.write = origWrite;
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nrevalidate checks passed");
