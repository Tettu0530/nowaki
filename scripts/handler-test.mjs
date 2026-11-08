// Unit checks for server/handler.mjs with an in-memory env: layout wrapping (plain and
// `streaming = "early"`), the routePath seam, and the finalize commit seam. No server needed.
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
  "routes/_middleware.ts": { default: (ctx) => void seenUrls.push(`mw ${ctx.url.pathname}`) },
  "routes/admin/_middleware.ts": { default: () => new Response("blocked", { status: 401 }) },
};
const table = {
  routes: [
    { file: "routes/blog/early.tsx", segments: [{ lit: "blog" }, { lit: "early" }], dir: "/blog", isApi: false },
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
  // Sessions will set ctx.__commit; the cookie it sets must reach the response.
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

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("handler: all checks passed");
