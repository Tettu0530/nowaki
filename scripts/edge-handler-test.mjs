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
check("live island renders its initial state", live.status === 200 && /live:\s*0/.test(await live.text()));
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
const bad = await rpc({ id: "675f80133a1699f8", args: [""] });
check("serverFn rejects invalid input (400)", bad.status === 400 && (await bad.json()).error === "Invalid input");
const broken = await rpc({ id: "96224074eee5e982", args: [] });
check("unexpected server function error is generic (500)", broken.status === 500 && (await broken.json()).error === "Internal Server Error");

process.env.NOWAKI_CSP = "enforce";
const csp = await req("/");
const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp.headers.get("content-security-policy") ?? "")?.[1];
const tags = (await csp.text()).match(/<(script|style)\b[^>]*>/gi) ?? [];
check("NOWAKI_CSP=enforce: every script/style carries the response nonce",
  Boolean(nonce) && tags.length > 0 && tags.every((t) => t.includes(`nonce="${nonce}"`)));
delete process.env.NOWAKI_CSP;

console.log(failures ? `\nEDGE HANDLER TEST FAILED (${failures})` : "\nEDGE HANDLER TEST PASSED");
process.exit(failures ? 1 : 0);
