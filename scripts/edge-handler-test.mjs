// Edge path unit test: imports the Cloudflare worker that `nowaki build --adapter cloudflare` wrote
// and calls its fetch handler directly in Node (no wrangler), covering web.mjs end to end.
// Usage: node scripts/edge-handler-test.mjs [workerDir]   (default examples/hello/dist/worker)
import path from "node:path";
import { pathToFileURL } from "node:url";

const workerDir = path.resolve(process.argv[2] ?? "examples/hello/dist/worker");
const worker = (await import(pathToFileURL(path.join(workerDir, "index.js")).href)).default;
const ORIGIN = "https://app.example";
const env = { ASSETS: { fetch: async () => new Response("asset", { headers: { "content-type": "text/javascript" } }) } };
const req = (p, init = {}) => worker.fetch(new Request(ORIGIN + p, init), env);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const secure = (r) => r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("x-frame-options") === "SAMEORIGIN";

const home = await req("/");
const homeHtml = await home.text();
check("page renders with islands (200)", home.status === 200 && homeHtml.includes("nowaki-island"));
check("page has the default security headers", secure(home));
const live = await req("/live");
const liveHtml = await live.text();
check("live island renders its initial state", live.status === 200 && /live:\s*0/.test(liveHtml));
check("live page ships live.js in POST mode", /<script[^>]*\/_nowaki\/live\.[0-9a-f]+\.js"[^>]*data-live-transport="post"/.test(liveHtml));
const liveTag = liveHtml.match(/<nowaki-live\b[^>]*>/)?.[0] ?? "";
const liveAttr = (n) => liveTag.match(new RegExp(`${n}="([^"]*)"`))?.[1];
const liveEv = (body, h = {}) =>
  req("/__nowaki/live-event", { method: "POST", headers: { "content-type": "application/json", "x-nowaki-live": "1", ...h }, body: JSON.stringify(body) });
const ev = { name: "LiveCounter", state: { count: 0 }, sig: liveAttr("sig"), handler: "inc" };
const inc = await liveEv(ev, { origin: ORIGIN });
const incBody = inc.status === 200 ? await inc.json() : {};
check("live-event inc → live: 1 with a new signature",
  /live:\s*1/.test(incBody.html ?? "") && incBody.state?.count === 1 && /^v1\./.test(incBody.sig ?? "") && incBody.sig !== ev.sig);
check("live-event cross-site rejected (403)", (await liveEv(ev, { origin: "https://evil.test" })).status === 403);
check("live-event forged signature rejected (403)", (await liveEv({ ...ev, sig: "FORGED" })).status === 403);
const doc = await req("/docs/intro");
const docHtml = await doc.text();
check("content collection page renders on the edge (inlined content)", doc.status === 200 && docHtml.includes('id="why-content-collections"'));
const envPage = await req("/env");
const envHtml = await envPage.text();
check("env.ts is validated on the edge and env/server reads it", envPage.status === 200 && envHtml.includes("token length 15"));
check("public env value renders on the edge", envHtml.includes('id="env-badge">Hello from env.ts x4<'));
const styled = await (await req("/styled")).text();
check("route CSS is linked on the edge", /<link rel="stylesheet" href="\/_nowaki\/styled\.[0-9a-f]+\.css"/.test(styled));
const ck = await req("/isr-cookie", { headers: { cookie: "user=alice" } });
check("ISR page reading a cookie is private on the edge", /private/.test(ck.headers.get("cache-control") || "") && !/s-maxage/.test(ck.headers.get("cache-control") || ""));
const sc = await req("/isr-sets-cookie");
check("ISR page that sets a cookie is private, no-cache on the edge",
  /visited=1/.test(sc.headers.get("set-cookie") || "") && sc.headers.get("cache-control") === "private, no-cache");
const vy = await req("/vary",{ headers: { "accept-language": "de" } });
check("ISR page reading accept-language sends Vary on the edge", /accept-language/i.test(vy.headers.get("vary") || ""));
const styledAttrs = await (await req("/styled")).text();
check("htmlAttrs / bodyAttrs on the edge", styledAttrs.includes('<html lang="ja" data-sheet-rev="3"') && styledAttrs.includes('<body class="site styled-page" data-site="hello"') && !styledAttrs.includes("onload"));
const scripted = await (await req("/scripted")).text();
check("page scripts on the edge", /<script type="module" src="\/_nowaki\/stamp\.[0-9a-f]+\.js" data-nowaki-script><\/script>/.test(scripted));
const gallery = await (await req("/gallery")).text();
check("<Image> renders AVIF + JPEG sources on the edge", /<source type="image\/avif" srcset="\/_nowaki\/hero-640\.[0-9a-f]+\.avif/.test(gallery) && gallery.includes('width="1200" height="750"'));
const fontPage = await (await req("/about")).text();
check("fonts: preload + stylesheet on the edge", /<link rel="preload" href="\/_nowaki\/atkinson-hyperlegible-400-normal\.[0-9a-f]+\.ttf" as="font"/.test(fontPage) && /<link rel="stylesheet" href="\/_nowaki\/fonts\.[0-9a-f]+\.css" \/>/.test(fontPage));
const pricing = await req("/pricing");
check("a route-group page on the edge: its layout and middleware",
  pricing.status === 200 && (await pricing.text()).includes('<div data-group="marketing"><main') && pricing.headers.get("x-route-group") === "marketing");
const photo = await (await req("/photos/1")).text();
check("parallel routes on the edge: the slot file matching the URL, its CSS", photo.includes('<nowaki-slot name="modal" style="display:contents"><aside id="photo-modal"') && /\/_nowaki\/modal\.[0-9a-f]+\.css/.test(photo));
check("parallel routes on the edge: the slot default", (await (await req("/photos")).text()).includes('<nowaki-slot name="modal" style="display:contents"><p id="modal-default">'));
const bounds = await (await req("/__nowaki/boundaries")).json();
check("loading / error boundaries on the edge", bounds.loading.length > 0 && bounds.error.length > 0);
const mdxPage = await (await req("/guide")).text();
check("an .mdx page on the edge", mdxPage.includes('<h1 id="an-mdx-page">An MDX page</h1>') && mdxPage.includes('<nowaki-island name="Counter"'));
const mdxEntry = await (await req("/docs/components")).text();
check("an .mdx content entry on the edge (its module is bundled)", mdxEntry.includes("an expression (42)"));
const mdocPage = await (await req("/markdoc")).text();
check("a page importing a .mdoc on the edge", mdocPage.includes('<h1 id="a-markdoc-page">A Markdoc page</h1>') && mdocPage.includes('<nowaki-island name="Counter"'));
const mdocEntry = await (await req("/docs/markdoc")).text();
check("a .mdoc content entry on the edge (its module is bundled)", mdocEntry.includes('class="callout callout-warning"'));
const sitemap = await (await req("/sitemap.xml")).text();
check("sitemap.xml on the edge uses the embedded site", sitemap.includes("<loc>https://hello.nowaki.dev/docs/intro</loc>"));
const docHead = await (await req("/docs/intro")).text();
check("typed meta on the edge", docHead.includes('<link rel="canonical" href="https://hello.nowaki.dev/docs/intro" />'));
const feed = await req("/feed.xml");
check("file route feed.xml on the edge", feed.headers.get("content-type") === "application/xml" && (await feed.text()).includes("<rss"));
const og = await req("/og/intro.png");
const ogBytes = new Uint8Array(await og.arrayBuffer());
check("file route og/[card].png returns PNG bytes on the edge", og.headers.get("content-type") === "image/png" && ogBytes[1] === 0x50 && ogBytes[2] === 0x4e);
const pub = await req("/robots.txt");
check("public/ files come from the ASSETS binding", (await pub.text()) === "asset" && secure(pub));
const pubEnc = await req("/media/hello%20world.txt");
check("public/ paths match percent-decoded", (await pubEnc.text()) === "asset");
const hidden = await req("/.hidden");
check("public/ dotfiles aren't assets", (await hidden.text()) !== "asset");
const api = await req("/api/hello");
check("API route returns JSON", api.status === 200 && (await api.json()).hello === "nowaki");
check("unknown path is 404", (await req("/nope")).status === 404);
const asset = await req("/_nowaki/x.js");
check("assets come from the ASSETS binding with security headers", (await asset.text()) === "asset" && secure(asset));

const form = (h) => req("/todos", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...h }, body: "text=edge" });
check("action: cross-site POST rejected (403)", (await form({ origin: "https://evil.test" })).status === 403);
check("action: same-origin POST allowed", (await form({ origin: ORIGIN })).status === 302);

const rpc = (body, h = {}) =>
  req("/__nowaki/fn", { method: "POST", headers: { "content-type": "application/json", "x-nowaki-rpc": "1", ...h }, body: JSON.stringify(body) });
check("RPC without x-nowaki-rpc rejected (403)",
  (await req("/__nowaki/fn", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 403);
check("RPC cross-origin rejected (403)", (await rpc({ id: "6c90d7dc921a9a3f", args: [] }, { origin: "https://evil.test" })).status === 403);
check("RPC forged x-forwarded-host cannot spoof origin check (403)",
  (await rpc({ id: "6c90d7dc921a9a3f", args: [] }, { origin: "https://evil.test", "x-forwarded-host": "app.example" })).status === 403);
check("RPC same-origin call ignores forged x-forwarded-host (200)",
  (await rpc({ id: "6c90d7dc921a9a3f", args: [] }, { origin: ORIGIN, "x-forwarded-host": "evil.test" })).status === 200);
const bad = await rpc({ id: "675f80133a1699f8", args: [""] });
check("serverFn rejects invalid input (400)", bad.status === 400 && (await bad.json()).error === "Invalid input");
const broken = await rpc({ id: "96224074eee5e982", args: [] });
check("unexpected server function error is generic (500)", broken.status === 500 && (await broken.json()).error === "Internal Server Error");

// Sessions: session.ts is imported by the worker; the secret comes from the Worker's bindings.
{
  const saved = process.env.NOWAKI_SESSION_SECRET;
  delete process.env.NOWAKI_SESSION_SECRET;
  const sess = (init = {}, bindings = env) =>
    worker.fetch(new Request(ORIGIN + "/api/session", { ...init, headers: { origin: ORIGIN, ...(init.headers ?? {}) } }), bindings);
  check("session without NOWAKI_SESSION_SECRET: 500", (await sess()).status === 500);
  const withSecret = { ...env, NOWAKI_SESSION_SECRET: "edge-binding-session-secret-0123456789" };
  const login = await sess({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "op=login&user=edge" }, withSecret);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check("session: login sets the session.ts cookie name, Secure over https",
    /^hello_session=v1\./.test(cookie) && /; Secure/.test(login.headers.get("set-cookie") ?? ""));
  const me = await (await sess({ headers: { cookie } }, withSecret)).json();
  check("session: the cookie round-trips (secret from the bindings)", me.user === "edge");
  const evil = await (await sess({ method: "POST", headers: { origin: "https://evil.test", cookie, "content-type": "application/x-www-form-urlencoded" }, body: "op=inc" }, withSecret)).json();
  check("session: cross-site POST sees an empty, read-only session", evil.user === null && evil.readOnly === true && evil.wrote !== true);
  if (saved !== undefined) process.env.NOWAKI_SESSION_SECRET = saved;
}

process.env.NOWAKI_CSP = "enforce";
const csp = await req("/");
const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp.headers.get("content-security-policy") ?? "")?.[1];
const tags = (await csp.text()).match(/<(script|style)\b[^>]*>/gi) ?? [];
check("NOWAKI_CSP=enforce: every script/style carries the response nonce",
  Boolean(nonce) && tags.length > 0 && tags.every((t) => t.includes(`nonce="${nonce}"`)));
delete process.env.NOWAKI_CSP;

// nowaki.config redirects / rewrites (examples/hello), applied before the Assets binding.
const moved = await req("/old-docs/guide?x=1", { redirect: "manual" });
check("config redirect on the edge keeps the query and the security headers",
  moved.status === 308 && moved.headers.get("location") === "/guide?x=1" && secure(moved));
const evil = await req("/go/%2F%2Fevil.com", { redirect: "manual" });
check("config redirect capture can't leave the site on the edge", evil.headers.get("location") === "/%2F%2Fevil.com");
check("config rewrite renders the destination on the edge", (await (await req("/p/hello")).text()).includes("Post: hello"));
const forged = await (await req("/about", { headers: { "x-nowaki-route-path": "/env" } })).text();
check("client x-nowaki-route-path is ignored on the edge", forged.includes("<h1>About</h1>") && !forged.includes("token length"));

console.log(failures ? `\nEDGE HANDLER TEST FAILED (${failures})` : "\nEDGE HANDLER TEST PASSED");
process.exit(failures ? 1 : 0);
