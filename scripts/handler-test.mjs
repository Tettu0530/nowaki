// Unit checks for server/handler.mjs with an in-memory env: layout wrapping (plain and
// `streaming = "early"`), early redirects, the routePath seam and ctx.routePath, the finalize
// commit seam, parallel-route slots, the cross-site (CSRF) rule for actions and API / file routes,
// the aliases removed in 0.20.0, OPTIONS never running an action, and the endpoint body caps.
// No server needed. Usage: node scripts/handler-test.mjs
import { createRequire } from "node:module";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";

const { h } = createRequire(new URL("../packages/nowaki-runtime/server/handler.mjs", import.meta.url))("preact");

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

const order = [];
const seenUrls = [];
const modules = {
  "routes/_layout.tsx": {
    loader: () => (order.push("root"), "R"),
    default: ({ data, children }) => h("div", { id: "root", "data-d": data }, children),
  },
  "routes/blog/_layout.tsx": {
    loader: () => (order.push("blog"), "B"),
    default: ({ data, children }) => h("section", { id: "blog", "data-d": data }, children),
  },
  "routes/blog/notalayout/_layout.tsx": { loader: () => order.push("skipped") },
  "routes/blog/[slug].tsx": {
    loader: (ctx) => (order.push("page"), ctx.params.slug),
    default: ({ data, url }) => (seenUrls.push(url.pathname), h("p", null, `post ${data}`)),
  },
  "routes/blog/early.tsx": {
    streaming: "early",
    loader: () => (order.push("page"), "E"),
    default: ({ data }) => h("p", null, `early ${data}`),
  },
  // An app-level open redirect after an early shell (`?next=` straight into ctx.redirect).
  "routes/blog/go.tsx": {
    streaming: "early",
    loader: (ctx) => ctx.redirect(ctx.url.searchParams.get("next")),
    default: () => h("p", null, "go"),
  },
  "routes/blog/act.tsx": {
    action: () => (order.push("action"), new Response(null, { status: 303, headers: { location: "/" } })),
    default: () => h("p", null, "act"),
  },
  "routes/_middleware.ts": { default: (ctx) => void seenUrls.push(`mw ${ctx.url.pathname}`) },
  "routes/admin/_middleware.ts": { default: () => new Response("blocked", { status: 401 }) },
};
const table = {
  routes: [
    { file: "routes/blog/early.tsx", segments: [{ lit: "blog" }, { lit: "early" }], dir: "/blog", isApi: false },
    { file: "routes/blog/go.tsx", segments: [{ lit: "blog" }, { lit: "go" }], dir: "/blog", isApi: false },
    { file: "routes/blog/act.tsx", segments: [{ lit: "blog" }, { lit: "act" }], dir: "/blog", isApi: false },
    { file: "routes/blog/[slug].tsx", segments: [{ lit: "blog" }, { param: "slug" }], dir: "/blog", isApi: false },
  ],
  layouts: [
    { prefix: "", file: "routes/_layout.tsx" },
    { prefix: "/blog", file: "routes/blog/_layout.tsx" },
    { prefix: "/blog/notalayout", file: "routes/blog/notalayout/_layout.tsx" },
  ],
  middleware: [
    { prefix: "", file: "routes/_middleware.ts" },
    { prefix: "/admin", file: "routes/admin/_middleware.ts" },
  ],
};
const env = {
  routeTable: async () => table,
  importModule: async (file) => modules[file],
  ensureIslands: async () => {},
  renderDocument: ({ body }) => body,
  renderShell: () => ({ head: "<head>", tail: "</tail>" }),
  renderError: (err) => ({ status: 500, headers: {}, body: String(err) }),
  onError: () => {},
};
const req = (path, extra = {}) =>
  handleRequest(env, { method: "GET", url: new URL(`http://x.test${path}`), headers: {}, version: 1, ...extra });
const text = async (res) => res.body ?? (await new Response(res.stream).text());

{
  order.length = 0;
  const res = await req("/blog/hello");
  check("page is wrapped root → leaf", (await text(res)) === '<div id="root" data-d="R"><section id="blog" data-d="B"><p>post hello</p></section></div>');
  check("loaders run page, then layouts leaf → root", order.join(",") === "page,blog,root");
  check("a layout without a default export is skipped", !order.includes("skipped"));
}

{
  order.length = 0;
  const res = await req("/blog/early");
  const body = await text(res);
  check("early streaming wraps the same layouts", body === '<head><div id="root" data-d="R"><section id="blog" data-d="B"><p>early E</p></section></div></tail>');
  check("early streaming runs loaders page, then layouts leaf → root", order.join(",") === "page,blog,root");
}

{
  // After an early shell a redirect is `location.replace(...)`: only http(s) targets.
  const go = async (next) => text(await req(`/blog/go?next=${encodeURIComponent(next)}`));
  check("early redirect follows a path", (await go("/about")).includes('location.replace("/about")'));
  check("early redirect follows an https URL", (await go("https://ok.test/x")).includes('location.replace("https://ok.test/x")'));
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
    const body = await go(bad);
    check(`early redirect refuses ${JSON.stringify(bad)} (goes to /)`, body.includes('location.replace("/")') && !/javascript:|data:/i.test(body));
  }
}

{
  seenUrls.length = 0;
  const res = await req("/p/hello", { routePath: "/blog/hello" });
  check("routePath picks the route", res.status === 200 && (await text(res)).includes("<p>post hello</p>"));
  check("ctx.url stays the browser URL", seenUrls.includes("/p/hello") && seenUrls.includes("mw /p/hello"));
}

{
  const res = await req("/blog/x", { routePath: "/admin/x" });
  check("middleware runs by routePath", res.status === 401);
  const miss = await req("/blog/hello", { routePath: "/nope" });
  check("404 by routePath", miss.status === 404);
}

{
  const res = await req("/blog/hello");
  check("without a commit hook the result has no set-cookie", res.headers["set-cookie"] === undefined);
}

{
  // Sessions set ctx.__commit (session.mjs); the cookie it sets must reach the response.
  const commits = [];
  const commitEnv = {
    ...env,
    importModule: async (file) =>
      file === "routes/_middleware.ts"
        ? {
            default: (ctx) => {
              ctx.__commit = async (result) => {
                await new Promise((r) => setTimeout(r, 1));
                commits.push(result.status);
                ctx.setCookie("sid", "abc");
              };
            },
          }
        : modules[file],
  };
  const res = await handleRequest(commitEnv, { method: "GET", url: new URL("http://x.test/blog/hello"), headers: {}, version: 1 });
  check("commit hook runs once before the headers are built", commits.length === 1 && commits[0] === 200);
  check("a cookie set in the commit hook is sent", String(res.headers["set-cookie"] ?? "").startsWith("sid=abc"));
  check("a response that sets a cookie stays 200 with its body", res.status === 200 && (await text(res)).includes("post hello"));
}

{
  // Parallel-route slots: CSS / scripts of the rendered slot file, early streaming, and the
  // per-table cache of which layouts own slots.
  const slotModules = {
    "routes/_layout.tsx": { default: ({ children, slots }) => h("div", null, children, slots.modal) },
    "routes/g/[id].tsx": { default: ({ params }) => h("p", null, `page ${params.id}`) },
    "routes/g/early.tsx": { streaming: "early", default: () => h("p", null, "early") },
    "routes/plain.tsx": { default: () => h("p", null, "plain") },
    "routes/@modal/g/[id].tsx": {
      scripts: ["./m.ts"],
      loader: (ctx) => `L${ctx.params.id}`,
      default: ({ data }) => h("b", null, data),
    },
    "routes/@modal/default.tsx": { default: () => h("i", null, "none") },
  };
  const slotTable = {
    routes: [
      { file: "routes/g/early.tsx", segments: [{ lit: "g" }, { lit: "early" }], dir: "/g", isApi: false },
      { file: "routes/g/[id].tsx", segments: [{ lit: "g" }, { param: "id" }], dir: "/g", isApi: false },
      { file: "routes/plain.tsx", segments: [{ lit: "plain" }], dir: "", isApi: false },
    ],
    layouts: [{ prefix: "", file: "routes/_layout.tsx" }],
    middleware: [],
    slots: [
      {
        ownerDir: "",
        name: "modal",
        routes: [{ file: "routes/@modal/g/[id].tsx", segments: [{ lit: "g" }, { param: "id" }] }],
        default: "routes/@modal/default.tsx",
        intercepts: [],
      },
    ],
  };
  const cssCalls = [];
  const slotEnv = {
    ...env,
    routeTable: async () => slotTable,
    importModule: async (file) => slotModules[file],
    renderDocument: ({ body, meta }) => `${meta?.head ?? ""}|${body}`,
    routeCss: async (file) => (cssCalls.push(file), file.includes("@modal/g") ? ["/site.css", "/modal.css"] : ["/site.css"]),
    routeScripts: async (file, mod) => (mod?.scripts ?? []).map((s) => ({ src: `/${file}/${s}` })),
  };
  const get = (path) => handleRequest(slotEnv, { method: "GET", url: new URL(`http://x.test${path}`), headers: {}, version: 1 });
  const body = await text(await get("/g/5"));
  check("a slot renders inside <nowaki-slot>", body.endsWith('|<div><p>page 5</p><nowaki-slot name="modal" style="display:contents"><b>L5</b></nowaki-slot></div>'));
  check(
    "the rendered slot file's CSS follows the page's, deduped",
    body.startsWith('<link rel="stylesheet" href="/site.css" />\n<link rel="stylesheet" href="/modal.css" />'),
  );
  check("the rendered slot file's page scripts are included", body.includes('src="/routes/@modal/g/[id].tsx/./m.ts"'));
  const plain = await text(await get("/plain"));
  check("the default renders where no slot route matches", plain.endsWith('<div><p>plain</p><nowaki-slot name="modal" style="display:contents"><i>none</i></nowaki-slot></div>'));
  check("a default's CSS is asked for", cssCalls.includes("routes/@modal/default.tsx"));
  const early = await text(await get("/g/early"));
  check("early streaming renders slots too", early.includes('<p>early</p><nowaki-slot name="modal" style="display:contents"><b>Learly</b></nowaki-slot>'));
  // The owners of a file's chain are computed once per table: a filter on table.slots that runs
  // again would see the replaced array.
  const saved = slotTable.slots;
  slotTable.slots = [{ ...saved[0], name: "other" }];
  check("slot owners are cached per table and file", (await text(await get("/g/6"))).includes('<nowaki-slot name="modal"'));
  slotTable.slots = saved;
  const noSlots = { ...slotTable, slots: [] };
  const res = await handleRequest({ ...slotEnv, routeTable: async () => noSlots }, { method: "GET", url: new URL("http://x.test/g/5"), headers: {}, version: 1 });
  check("without slots a layout gets an empty slots object", (await text(res)).endsWith("|<div><p>page 5</p></div>"));
}

// CSRF: unsafe-method cross-site requests to API and file routes get the same 403 as page
// actions (after middleware), unless the route exports `csrf = false`. GET / HEAD / OPTIONS pass.
{
  let mwRuns = 0;
  const csrfModules = {
    "routes/_middleware.ts": { default: () => void mwRuns++ },
    "routes/api/plain.ts": { GET: () => ({ ok: "get" }), POST: () => ({ ok: "post" }), PUT: () => ({}), PATCH: () => ({}), DELETE: () => ({}), OPTIONS: () => ({ ok: "options" }) },
    "routes/api/strict.ts": { csrf: true, POST: () => ({ ok: "post" }) },
    "routes/api/hook.ts": { csrf: false, POST: () => ({ ok: "hook" }) },
    "routes/feed.xml.ts": { default: () => ({ headers: { "content-type": "application/xml" }, body: "<rss/>" }) },
    "routes/todos.tsx": { action: () => ({ ok: true }), default: () => h("p", null, "todos") },
  };
  const api = (file, lit, fileExt) => ({ file, segments: lit.split("/").filter(Boolean).map((l) => ({ lit: l })), dir: "/", isApi: true, fileExt });
  const csrfTable = {
    routes: [
      api("routes/api/plain.ts", "/api/plain"),
      api("routes/api/strict.ts", "/api/strict"),
      api("routes/api/hook.ts", "/api/hook"),
      api("routes/feed.xml.ts", "/feed.xml", "xml"),
      { file: "routes/todos.tsx", segments: [{ lit: "todos" }], dir: "/", isApi: false },
    ],
    layouts: [],
    middleware: [{ prefix: "", file: "routes/_middleware.ts" }],
  };
  const csrfEnv = { ...env, routeTable: async () => csrfTable, importModule: async (file) => csrfModules[file] };
  const send = (method, path, headers = {}) =>
    handleRequest(csrfEnv, {
      method,
      url: new URL(`http://app.test${path}`),
      headers: { host: "app.test", ...headers },
      readBody: async () => new Uint8Array(),
      version: 1,
    });
  const evil = { origin: "https://evil.test" };
  const action = await send("POST", "/todos", evil);
  const rejected = await send("POST", "/api/plain", evil);
  check("csrf: cross-site API POST is rejected (403)", rejected.status === 403);
  check(
    "csrf: the API rejection is the page action's response (status, headers, body)",
    action.status === 403 && JSON.stringify([rejected.status, rejected.headers, rejected.body]) === JSON.stringify([action.status, action.headers, action.body]),
  );
  for (const m of ["PUT", "PATCH", "DELETE"]) check(`csrf: cross-site API ${m} is rejected (403)`, (await send(m, "/api/plain", evil)).status === 403);
  check("csrf: Origin null is rejected (403)", (await send("POST", "/api/plain", { origin: "null" })).status === 403);
  check("csrf: Sec-Fetch-Site cross-site without Origin is rejected (403)", (await send("POST", "/api/plain", { "sec-fetch-site": "cross-site" })).status === 403);
  check("csrf: same-origin API POST is allowed", (await send("POST", "/api/plain", { origin: "http://app.test" })).status === 200);
  check("csrf: Sec-Fetch-Site same-origin without Origin is allowed", (await send("POST", "/api/plain", { "sec-fetch-site": "same-origin" })).status === 200);
  check("csrf: POST without Origin or Sec-Fetch-Site (curl, server) is allowed", (await send("POST", "/api/plain")).status === 200);
  check("csrf: cross-site GET is unaffected", (await send("GET", "/api/plain", evil)).status === 200);
  check("csrf: cross-site OPTIONS is unaffected", (await send("OPTIONS", "/api/plain", evil)).status === 200);
  check("csrf: `csrf = true` still rejects (403)", (await send("POST", "/api/strict", evil)).status === 403);
  check("csrf: `csrf = false` accepts a cross-site POST", (await send("POST", "/api/hook", evil)).status === 200);
  check("csrf: a file route rejects a cross-site POST (403)", (await send("POST", "/feed.xml", evil)).status === 403);
  check("csrf: a file route still answers a cross-site GET", (await send("GET", "/feed.xml", evil)).status === 200);
  mwRuns = 0;
  await send("POST", "/api/plain", evil);
  check("csrf: middleware runs before the check, as for actions", mwRuns === 1);
}

// ctx.routePath, and the aliases removed in 0.20.0 (`export const middleware`, lowercase API
// method exports): each is an error naming the new form, not a silent change.
{
  const seen = [];
  const mods = {
    "routes/photo/[id].tsx": { default: () => h("p", null, "photo") },
    "routes/api/r.ts": { GET: (ctx) => ctx.json({ routePath: ctx.routePath }) },
    "routes/api/lower.ts": { get: () => ({ ok: true }), POST: () => ({ ok: true }) },
    "routes/old/_middleware.ts": { middleware: () => new Response("old", { status: 401 }) },
    "routes/_middleware.ts": { default: (ctx) => void seen.push(ctx.routePath) },
  };
  const t = {
    routes: [
      { file: "routes/photo/[id].tsx", segments: [{ lit: "photo" }, { param: "id" }], dir: "/photo", isApi: false },
      { file: "routes/api/r.ts", segments: [{ lit: "api" }, { lit: "r" }], dir: "/api", isApi: true },
      { file: "routes/api/lower.ts", segments: [{ lit: "api" }, { lit: "lower" }], dir: "/api", isApi: true },
    ],
    layouts: [],
    middleware: [
      { prefix: "", file: "routes/_middleware.ts" },
      { prefix: "/old", file: "routes/old/_middleware.ts" },
    ],
  };
  const errors = [];
  const e = {
    ...env,
    routeTable: async () => t,
    importModule: async (file) => mods[file],
    renderError: (err) => (errors.push(String(err?.message ?? err)), { status: 500, headers: {}, body: "error" }),
  };
  const go = (path, extra = {}) => handleRequest(e, { method: "GET", url: new URL(`http://x.test${path}`), headers: {}, version: 1, ...extra });

  const r = await go("/app/api/r", { routePath: "/api/r" });
  check("ctx.routePath is the routed path, without basePath", JSON.parse(r.body).routePath === "/api/r");
  seen.length = 0;
  await go("/photo/1");
  check("ctx.routePath without a front is url.pathname", seen[0] === "/photo/1");

  const { compileI18n } = await import("../packages/nowaki-runtime/server/i18n.mjs");
  const i18nEnv = { ...e, i18n: compileI18n({ i18n: { locales: ["en", "ja"], defaultLocale: "en" }, basePath: "/app" }) };
  seen.length = 0;
  const ja = await handleRequest(i18nEnv, { method: "GET", url: new URL("http://x.test/app/ja/photo/1"), routePath: "/ja/photo/1", headers: {}, version: 1 });
  check("ctx.routePath drops the locale prefix too", ja.status === 200 && seen[0] === "/photo/1");

  errors.length = 0;
  const old = await go("/old/x");
  check("`export const middleware` is refused with an error", old.status === 500 && /export const middleware.*removed in 0\.20\.0.*export default/.test(errors.join(" ")));

  errors.length = 0;
  const lowerGet = await go("/api/lower");
  const lowerPost = await go("/api/lower", { method: "POST" });
  check(
    "a lowercase API method export is refused for every method",
    lowerGet.status === 500 && lowerPost.status === 500 && errors.length === 2 && errors.every((m) => /exports `get`.*uppercase \(`GET`\)/.test(m)),
  );
}

{
  // A CORS preflight (OPTIONS, from any site, unchecked for CSRF) never runs a page action.
  order.length = 0;
  const pre = await req("/blog/act", { method: "OPTIONS", headers: { origin: "http://evil.test", host: "x.test" } });
  check("OPTIONS does not run the action", !order.includes("action") && pre.status !== 303);
  const post = await req("/blog/act", { method: "POST", headers: { origin: "http://x.test", host: "x.test" } });
  check("same-origin POST still runs the action", order.includes("action") && post.status === 303);
}

{
  // Endpoint body caps hold for a streamed body with no Content-Length (a chunked POST on the
  // node adapter), not only against the header: server functions 1 MiB, live events and the
  // revalidate endpoint 64 KiB (the general 10 MiB form cap would otherwise apply).
  const { Readable } = await import("node:stream");
  let pulled = 0;
  const stream = (bytes) => {
    pulled = 0;
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    let left = bytes;
    return Readable.from((function* () {
      while (left > 0) {
        left -= chunk.length;
        pulled += chunk.length;
        yield chunk;
      }
    })());
  };
  const json = { "content-type": "application/json", "x-nowaki-rpc": "1", "x-nowaki-live": "1", authorization: "Bearer s3cret-for-handler-test" };
  const post = (path, bytes, extraEnv = {}) =>
    handleRequest({ ...env, ...extraEnv }, { method: "POST", url: new URL(`http://x.test${path}`), headers: { ...json, host: "x.test" }, req: stream(bytes), version: 1 });
  const fn = await post("/__nowaki/fn", 3 * 1024 * 1024, { serverFunctions: { lookup: async () => null, importModule: async () => ({}) } });
  check(`server function: a streamed 3 MiB body is refused at 1 MiB (413, read ${pulled >> 10} KiB)`, fn.status === 413 && pulled <= 1024 * 1024 + 64 * 1024);
  const live = await post("/__nowaki/live-event", 1024 * 1024, { live: { lookup: async () => null } });
  check(`live-event: a streamed 1 MiB body is refused at 64 KiB (413, read ${pulled >> 10} KiB)`, live.status === 413 && pulled <= 128 * 1024);
  process.env.NOWAKI_REVALIDATE_SECRET = "s3cret-for-handler-test  ";
  const rv = await post("/__nowaki/revalidate", 1024 * 1024);
  check(`revalidate: a streamed 1 MiB body is refused at 64 KiB (413; secret with trailing spaces still matches)`, rv.status === 413 && pulled <= 128 * 1024);
  process.env.NOWAKI_REVALIDATE_SECRET = "   ";
  check("revalidate: a blank secret leaves the endpoint off (404)", (await post("/__nowaki/revalidate", 10)).status === 404);
  delete process.env.NOWAKI_REVALIDATE_SECRET;
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("handler: all checks passed");
