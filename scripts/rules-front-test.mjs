// The JS fronts' use of the routing rules: server/front.mjs (app.mjs and the Cloudflare worker)
// and server/vercel-routes.mjs (redirects and headers as Vercel routes). The Vercel routes are run
// against every request in the shared rules fixture: a native redirect must answer exactly as
// applyRules does, or not match at all (the function then answers).
// Usage: node scripts/rules-front-test.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRules, compileRules } from "../packages/nowaki-runtime/server/rules.mjs";
import { frontHeaders, frontStep, withHeaderDefaults, withQuery } from "../packages/nowaki-runtime/server/front.mjs";
import { vercelHeaders, vercelRedirects } from "../packages/nowaki-runtime/server/vercel-routes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(await readFile(path.join(ROOT, "crates/nowaki-core/tests/fixtures/rules-cases.json"), "utf8"));

let failed = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok || process.env.VERBOSE) console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

// --- front.mjs ---
eq(withQuery("/a", ""), "/a", "withQuery: no query");
eq(withQuery("/a", "?"), "/a", "withQuery: empty query");
eq(withQuery("/a", "?x=1"), "/a?x=1", "withQuery: appended");
eq(withQuery("/a?b=2#top", "?x=1"), "/a?b=2&x=1#top", "withQuery: after the destination's, before the fragment");
const rules = compileRules({
  basePath: "/app",
  redirects: [{ source: "/go/[to]", destination: "/[to]", status: 307 }],
  rewrites: [{ source: "/p/[id]", destination: "/photo/[id]" }],
});
const step = (p, method = "GET") => frontStep(rules, method, new URL(p, "http://x"));
eq(step("/app/go/%2F%2Fevil.com?q=1"), { redirect: { status: 307, location: "/app/%2F%2Fevil.com?q=1" } }, "frontStep: open redirect stays on the site");
eq(step("/app/p/1"), { routePath: "/photo/1" }, "frontStep: rewrite");
eq(step("/app/about"), { routePath: "/about" }, "frontStep: basePath removed");
eq(step("/about"), { notFound: true }, "frontStep: outside basePath");
eq(step("/_nowaki/a.js"), null, "frontStep: root assets are never matched");
eq(step("/__nowaki/fn", "POST"), null, "frontStep: framework endpoints are never matched");
eq(step("/app/_nowaki/a.js"), { routePath: "/_nowaki/a.js" }, "frontStep: assets under basePath");
eq(frontStep(compileRules({ redirects: [{ source: "/a", destination: "/b" }] }), "GET", new URL("http://x/c")), null, "frontStep: same path is null");
{
  const r = withHeaderDefaults(new Response("x", { headers: { "cache-control": "max-age=5" } }), [["cache-control", "no-store"], ["x-a", "1"]]);
  eq([r.headers.get("cache-control"), r.headers.get("x-a")], ["max-age=5", "1"], "withHeaderDefaults: fills, never replaces");
  const same = new Response("y");
  eq(withHeaderDefaults(same, []) === same, true, "withHeaderDefaults: nothing to add returns the response");
}

{
  const all = compileRules({ headers: [{ source: "/[...all]", headers: [{ key: "cache-control", value: "public, max-age=3600" }] }] });
  eq(frontHeaders(all, "/__nowaki/fn"), [], "frontHeaders: none on framework endpoints");
  eq(frontHeaders(all, "/_nowaki/a.js"), [["cache-control", "public, max-age=3600"]], "frontHeaders: assets get them");
  eq(vercelHeaders(all).some((r) => new RegExp(r.src).test("/__nowaki/fn")), false, "vercel headers: none on framework endpoints");
}

// --- vercel-routes.mjs ---
// Vercel substitutes `$name` with the named group.
const runVercel = (routes, p) => {
  for (const r of routes) {
    const m = new RegExp(r.src).exec(p);
    if (!m) continue;
    const location = r.headers.Location.replace(/\$(n\d+)/g, (_, n) => m.groups[n]);
    return { redirect: { status: r.status, location } };
  }
  return null;
};
const safeDecode = (p) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
};

let native = 0;
const extra = ["/old/a%20b", "/old/./x", "/go/.", "/go/...", "/go/a.b", "/old/a/", "/old//a", "/blog/x/", "/og/..png", "/og/.x.png"];
for (const c of fixture.cases) {
  if (c.error) continue;
  const compiled = compileRules(c.config);
  const routes = vercelRedirects(compiled);
  for (const r of [...c.requests, ...extra.map((p) => ({ path: p }))]) {
    const method = r.method ?? "GET";
    if (method !== "GET") continue;
    const want = applyRules(compiled, method, r.path);
    const got = runVercel(routes, r.path);
    if (got) {
      native++;
      eq(got, want, `vercel: ${c.name}: ${r.path}`);
    }
    // If Vercel matched the decoded path instead, a native answer must still stay on the site.
    const decoded = safeDecode(r.path);
    const viaDecoded = decoded && decoded !== r.path ? runVercel(routes, decoded) : null;
    if (viaDecoded) {
      const loc = viaDecoded.redirect.location;
      eq(/^https?:\/\//.test(loc) || (loc[0] === "/" && loc[1] !== "/" && loc[1] !== "\\"), true, `vercel (decoded): ${c.name}: ${r.path} → ${loc}`);
    }
  }
}
eq(native >= 20, true, `vercel: the fixture exercises native redirects (${native})`);

// A rule the platform can't express stops the native list, so later rules can't jump ahead of it.
{
  const r = compileRules({
    redirects: [
      { source: "/a/[x]", destination: "/p/[x]?ref=1", status: 307 },
      { source: "/a/b", destination: "/lit", status: 307 },
    ],
  });
  eq(vercelRedirects(r), [], "vercel: an inexpressible rule ends the native list");
}
{
  const r = compileRules({ trailingSlash: "always", redirects: [{ source: "/a/[x]", destination: "/b/[x]", status: 308 }] });
  eq(vercelRedirects(r), [], "vercel: \"always\" with a captured last segment is left to the function");
}
{
  const r = compileRules({
    basePath: "/app",
    headers: [
      { source: "/api/[...rest]", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/", headers: [{ key: "x-root", value: "1" }] },
    ],
  });
  const routes = vercelHeaders(r);
  const hit = (p) => routes.filter((x) => new RegExp(x.src).test(p)).map((x) => x.headers);
  eq(hit("/app/api/a/b"), [{ "cache-control": "no-store" }], "vercel headers: catch-all under basePath");
  eq(hit("/api/a"), [], "vercel headers: outside basePath");
  eq(hit("/app"), [{ "x-root": "1" }], "vercel headers: the root under basePath");
  eq(routes.every((x) => x.continue === true), true, "vercel headers: continue to the next route");
}
eq(vercelRedirects(null), [], "vercel: no rules, no routes");

console.log(failed ? `\nRULES FRONT TEST FAILED (${failed})` : `\nRULES FRONT TEST PASSED (${native} native redirects checked)`);
process.exit(failed ? 1 : 0);
