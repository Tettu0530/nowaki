// Routing rules (server/rules.mjs) against the shared fixture that nowaki-core's
// tests/rules.rs also runs, plus nowaki.config normalization (server/site-config.mjs).
// Usage: node scripts/rules-test.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRules, compileRules, ruleHeaders } from "../packages/nowaki-runtime/server/rules.mjs";
import { normalizeConfig } from "../packages/nowaki-runtime/server/site-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(await readFile(path.join(ROOT, "crates/nowaki-core/tests/fixtures/rules-cases.json"), "utf8"));

let failed = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

for (const c of fixture.cases) {
  if (c.error) {
    let threw = false;
    try {
      compileRules(c.config);
    } catch {
      threw = true;
    }
    eq(threw, true, `${c.name}: rejected`);
    continue;
  }
  const rules = compileRules(c.config);
  for (const r of c.requests) {
    const method = r.method ?? "GET";
    eq(applyRules(rules, method, r.path), r.expect, `${c.name}: ${method} ${r.path}`);
    if (r.headers) eq(ruleHeaders(rules, r.path), r.headers, `${c.name}: headers ${r.path}`);
  }
}

eq(compileRules({}), null, "an empty config compiles to nothing");
eq(compileRules({ i18n: { locales: ["en"], defaultLocale: "en" } }), null, "i18n alone adds no per-request rule");

// nowaki.config normalization: what routing.json gets.
const routing = async (config) => (await normalizeConfig(config)).routing;
const rejects = async (config, match, label) => {
  try {
    await normalizeConfig(config);
    eq("accepted", "rejected", label);
  } catch (e) {
    eq(match.test(e.message), true, `${label} (${e.message})`);
  }
};

eq(await routing({}), undefined, "no routing keys: no routing.json");
eq(await routing({ basePath: "/", trailingSlash: "ignore", redirects: [] }), undefined, "defaults: no routing.json");
eq(await routing({ basePath: "/app/" }), { basePath: "/app" }, "basePath loses its trailing slash");
eq(
  await routing({
    redirects: [
      { source: "/old/[...rest]/", destination: "/new/[...rest]", permanent: true },
      { source: "/a", destination: "/b" },
      { source: "/c", destination: "https://example.com/c", statusCode: 301 },
    ],
  }),
  {
    redirects: [
      { source: "/old/[...rest]", destination: "/new/[...rest]", status: 308 },
      { source: "/a", destination: "/b", status: 307 },
      { source: "/c", destination: "https://example.com/c", status: 301 },
    ],
  },
  "redirects: permanent → 308, default 307, statusCode",
);
eq(
  await routing({ redirects: async () => [{ source: "/caf%C3%A9", destination: "/café au lait" }] }),
  { redirects: [{ source: "/café", destination: "/caf%C3%A9%20au%20lait", status: 307 }] },
  "async redirects; sources decoded, destinations encoded",
);
eq(
  await routing({ headers: [{ source: "/api/[...rest]", headers: { "Cache-Control": "no-store", "X-N": 1 } }] }),
  { headers: [{ source: "/api/[...rest]", headers: [{ key: "cache-control", value: "no-store" }, { key: "x-n", value: "1" }] }] },
  "headers: object form, names lowercased, numbers as strings",
);
eq(
  await routing({ headers: () => [{ source: "/", headers: [{ key: "X-A", value: "1" }] }] }),
  { headers: [{ source: "/", headers: [{ key: "x-a", value: "1" }] }] },
  "headers: function returning the { key, value } form",
);
eq(
  await routing({ i18n: { locales: ["en", "ja", "pt-BR"], defaultLocale: "en", detect: true } }),
  { i18n: { locales: ["en", "ja", "pt-BR"], defaultLocale: "en", prefixDefaultLocale: false, detect: true } },
  "i18n defaults",
);
eq(
  (await normalizeConfig({ images: { remotePatterns: [{ protocol: "https", hostname: "Images.Example.com", pathname: "/photos/**" }] } }))
    .images,
  { remotePatterns: [{ protocol: "https", hostname: "images.example.com", pathname: "/photos/**" }] },
  "images.remotePatterns",
);
eq(
  (await normalizeConfig({ site: "https://example.com/", fonts: [{ family: "X" }] })),
  { site: "https://example.com", fonts: [{ family: "X" }] },
  "site and fonts as before",
);

await rejects({ site: "example.com" }, /site must be an absolute URL/, "invalid site keeps its message");
await rejects({ basePath: "app" }, /basePath/, "basePath without a leading slash");
await rejects({ basePath: "/a/[b]" }, /basePath/, "basePath with a param");
await rejects({ basePath: "/__nowaki" }, /reserved/, "basePath under /__nowaki/");
await rejects({ trailingSlash: true }, /trailingSlash/, "trailingSlash must be a policy name");
await rejects({ redirects: {} }, /must be an array/, "redirects must be an array");
await rejects({ redirects: [{ source: "/a", destination: "/b", destionation: "/c" }] }, /unknown key "destionation"/, "unknown keys are typos");
await rejects({ redirects: [{ source: "/a", destination: "/b", statusCode: 200 }] }, /statusCode/, "statusCode must be a redirect status");
await rejects({ redirects: [{ source: "/a", destination: "//evil.com" }] }, /destination/, "protocol-relative destination");
await rejects({ redirects: [{ source: "/a", destination: "/\\evil.com" }] }, /destination/, "backslash destination");
await rejects({ redirects: [{ source: "/a", destination: "javascript:alert(1)" }] }, /destination/, "javascript: destination");
await rejects({ redirects: [{ source: "/[h]", destination: "https://[h]/x" }] }, /destination/, "capture in a host");
await rejects({ redirects: [{ source: "/a", destination: "https://bücher.example/" }] }, /punycode/, "non-ASCII host");
await rejects({ redirects: [{ source: "/__nowaki/hmr", destination: "/x" }] }, /reserved/, "source under /__nowaki/");
await rejects({ redirects: [{ source: "/a/[x]", destination: "/b/[y]" }] }, /\[y\]/, "unknown destination param");
await rejects({ rewrites: [{ source: "/a", destination: "https://example.com/" }] }, /internal/, "external rewrite");
await rejects({ rewrites: [{ source: "/x", destination: "/__nowaki/live-render" }] }, /reserved/, "rewrite to /__nowaki/");
await rejects({ headers: [{ source: "/a", headers: { "x-a": "1\r\nSet-Cookie: s=1" } }] }, /CR, LF or NUL/, "CRLF header value");
await rejects({ headers: [{ source: "/a", headers: { "x a": "1" } }] }, /header name/, "non-token header name");
await rejects({ headers: [{ source: "/a", headers: {} }] }, /empty/, "empty headers");
await rejects({ i18n: { locales: ["en"], defaultLocale: "ja" } }, /defaultLocale/, "defaultLocale outside locales");
await rejects({ i18n: { locales: ["en", "en_US"], defaultLocale: "en" } }, /locale tag/, "malformed locale tag");
await rejects({ i18n: { locales: ["en", "EN"], defaultLocale: "en" } }, /twice/, "duplicate locale");
await rejects({ i18n: { locales: [], defaultLocale: "en" } }, /non-empty/, "no locales");
await rejects({ images: { remotePatterns: [{ hostname: "*.evil*.com" }] } }, /hostname/, "wildcard in the middle of a host");
await rejects({ images: { remotePatterns: [{ hostname: "a.com", protocol: "ftp" }] } }, /protocol/, "ftp remote pattern");
await rejects({ images: { remotePatterns: [{ hostname: "a.com", pathname: "photos" }] } }, /pathname/, "relative pathname");

console.log(failed ? `\nRULES TEST FAILED (${failed})` : "\nRULES TEST PASSED");
process.exit(failed ? 1 : 0);
