// Routing rules (server/rules.mjs) against the shared fixture that nowaki-core's
// tests/rules.rs also runs, plus nowaki.config normalization (server/site-config.mjs).
// Usage: node scripts/rules-test.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRules, compileRules, negotiateLocale, ruleHeaders } from "../packages/nowaki-runtime/server/rules.mjs";
import { CONFIG_KEYS, FONT_KEYS, configOf, didYouMean, normalizeConfig } from "../packages/nowaki-runtime/server/site-config.mjs";

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
    if ("negotiate" in r) {
      eq(
        negotiateLocale(rules, method, r.path, r.acceptLanguage, r.cookie),
        r.negotiate,
        `${c.name}: negotiate ${method} ${r.path} ${JSON.stringify(r.acceptLanguage ?? null)} ${JSON.stringify(r.cookie ?? null)}`,
      );
    }
  }
}

// Accept-Language bounds (the Rust side has the same unit test).
{
  const rules = compileRules({ i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true } });
  const neg = (al) => negotiateLocale(rules, "GET", "/", al);
  eq(neg("ja"), { redirect: { status: 307, location: "/ja" } }, "detect: ja");
  eq(neg("fr,".repeat(32) + "ja"), { stay: true }, "detect: a range past the 32nd is never read");
  eq(neg("fr,".repeat(31) + "ja"), { redirect: { status: 307, location: "/ja" } }, "detect: the 32nd range is read");
  eq(neg("ja," + "x".repeat(4096)), { stay: true }, "detect: an oversized header counts as absent");
  eq(applyRules(rules, "GET", "/a/"), { pass: "/a/" }, "detect alone: applyRules passes through");
}

eq(compileRules({}), null, "an empty config compiles to nothing");
eq(compileRules({ i18n: { locales: ["en"], defaultLocale: "en" } }), null, "i18n alone adds no per-request rule");
eq(compileRules({ i18n: { locales: ["en"], defaultLocale: "en", detect: false } }), null, "i18n without detect adds no per-request rule");
eq(compileRules({ i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true } }) !== null, true, "i18n.detect compiles to rules");

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
  await routing({
    redirects: [
      { source: "/ja/a", destination: "/ja/b", locale: false },
      { source: "/c", destination: "/d", locale: true },
    ],
    rewrites: [{ source: "/ja/p", destination: "/x", locale: false }],
    headers: [{ source: "/ja/[...rest]", headers: { "x-a": "1" }, locale: false }],
  }),
  {
    redirects: [
      { source: "/ja/a", destination: "/ja/b", status: 307, locale: false },
      { source: "/c", destination: "/d", status: 307 },
    ],
    rewrites: [{ source: "/ja/p", destination: "/x", locale: false }],
    headers: [{ source: "/ja/[...rest]", headers: [{ key: "x-a", value: "1" }], locale: false }],
  },
  "locale: false is kept, true (the default) left out",
);
eq(
  (await normalizeConfig({ images: { remotePatterns: [{ protocol: "https", hostname: "Images.Example.com", pathname: "/photos/**" }] } }))
    .images,
  { remotePatterns: [{ protocol: "https", hostname: "images.example.com", pathname: "/photos/**" }] },
  "images.remotePatterns",
);
eq(
  (await normalizeConfig({ site: "https://example.com/", fonts: [{ family: "X", provider: "google" }] })),
  { site: "https://example.com", fonts: [{ family: "X", provider: "google" }] },
  "site and fonts as before",
);

// Top-level keys: anything outside CONFIG_KEYS is a typo, with the closest key suggested.
eq(CONFIG_KEYS.includes("plugins") && CONFIG_KEYS.includes("basePath"), true, "CONFIG_KEYS lists the keys");
eq(await normalizeConfig({ plugins: [] }), {}, "plugins alone is fine");
await rejects({ basepath: "/app" }, /^unknown top-level key "basepath"\. Did you mean "basePath"\?/, "unknown top-level key, with a hint");
await rejects({ redirect: [] }, /Did you mean "redirects"\?/, "a missing s");
await rejects({ trailingSlashes: "never" }, /Did you mean "trailingSlash"\?/, "an extra suffix");
await rejects({ cors: {} }, /unknown top-level key "cors"\. \(allowed: site, fonts/, "no hint when nothing is close");
await rejects({ plugins: {} }, /plugins must be an array/, "plugins must be an array");
await rejects({ redirects: [{ source: "/a", destination: "/b", permanentz: true }] }, /Did you mean "permanent"\?/, "nested keys get the hint too");
eq(didYouMean("i18N", CONFIG_KEYS), "i18n", "case is ignored");
eq(didYouMean("x", CONFIG_KEYS), null, "a short unrelated name has no hint");

// configOf: the default export; `export const config` alone was an alias, removed in 0.20.0.
eq(configOf({ default: { site: "https://a.b" } }), { site: "https://a.b" }, "configOf reads the default export");
eq(configOf({}), {}, "configOf: an empty module is an empty config");
let aliasErr = "";
try {
  configOf({ config: { site: "https://a.b" } });
} catch (e) {
  aliasErr = e.message;
}
eq(/`export const config` is no longer read.*export default/.test(aliasErr), true, `export const config is refused (${aliasErr})`);

// fonts: one shape per kind, unknown keys and the other kind's keys refused.
const fontsOk = [
  { family: "Inter", provider: "google", weights: [400, 700], styles: ["normal", "italic"], subsets: ["latin"], display: "optional", variable: "--font-body", preload: false, fallback: "serif" },
  { family: "Brand", src: "./fonts/brand.ttf", weight: 400, style: "italic" },
  { family: "Geist", src: "./fonts/v.woff2", weight: "100 900" },
  { family: "Multi", src: [{ path: "./a.ttf", weight: 400 }, { path: "./b.ttf", weight: 700, style: "italic" }] },
];
eq((await normalizeConfig({ fonts: fontsOk })).fonts, fontsOk, "valid fonts pass as written");
eq(FONT_KEYS.google.includes("weights") && FONT_KEYS.local.includes("weight"), true, "FONT_KEYS lists both shapes");
await rejects({ fonts: {} }, /fonts must be an array/, "fonts must be an array");
await rejects({ fonts: [{ family: "X" }] }, /fonts\[0\]: give `src`.*or `provider: "google"`/, "a font needs src or provider");
await rejects({ fonts: [{ family: "X", provider: "adobe" }] }, /provider must be "google"/, "only the google provider");
await rejects({ fonts: [{ family: "X", src: "./x.ttf", weights: [400] }] }, /`weights` is for `provider: "google"`; a local font takes `weight`/, "weights on a local font");
await rejects({ fonts: [{ family: "X", src: "./x.ttf", subsets: ["latin"] }] }, /`subsets` is for `provider: "google"`/, "subsets on a local font");
await rejects({ fonts: [{ family: "X", provider: "google", weight: 400 }] }, /`weight` is for a local font.*`weights: \[400, 700\]`/, "weight on a Google font");
await rejects({ fonts: [{ family: "X", provider: "google", src: "./x.ttf" }] }, /`src` is for a local font/, "src and provider together");
await rejects({ fonts: [{ family: "X", provider: "google", weightz: [400] }] }, /unknown key "weightz"\. Did you mean "weights"\?/, "a typo in a font key");
await rejects({ fonts: [{ family: "X", src: [{ path: "./a.ttf" }], weight: 400 }] }, /put `weight` \/ `style` in each entry/, "weight beside an src array");
await rejects({ fonts: [{ family: "X", src: [{ file: "./a.ttf" }] }] }, /src\[0\]: unknown key "file"/, "unknown src entry key");
await rejects({ fonts: [{ family: "X", src: "./a.ttf", weight: 1200 }] }, /weight must be/, "weight out of range");
await rejects({ fonts: [{ family: "X", src: "./a.ttf", style: "oblique" }] }, /style must be "normal" or "italic"/, "style");
await rejects({ fonts: [{ family: "X", provider: "google", display: "fast" }] }, /display must be one of/, "display");
await rejects({ fonts: [{ family: "X", provider: "google", variable: "font-x" }] }, /variable must be a CSS custom property/, "variable");
await rejects({ fonts: [{ family: "", provider: "google" }] }, /family must be a non-empty string/, "family");

await rejects({ site: "example.com" }, /site must be an absolute URL/, "invalid site keeps its message");
await rejects({ basePath: "app" }, /basePath/, "basePath without a leading slash");
await rejects({ basePath: "/a/[b]" }, /basePath/, "basePath with a param");
await rejects({ basePath: "/__nowaki" }, /reserved/, "basePath under /__nowaki/");
await rejects({ trailingSlash: true }, /trailingSlash/, "trailingSlash must be a policy name");
await rejects({ redirects: {} }, /must be an array/, "redirects must be an array");
await rejects({ redirects: [{ source: "/a", destination: "/b", target: "/c" }] }, /unknown key "target"/, "unknown keys are typos");
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
await rejects({ redirects: [{ source: "/a", destination: "/b", locale: "no" }] }, /locale must be a boolean/, "redirect locale must be a boolean");
await rejects({ rewrites: [{ source: "/a", destination: "/b", locale: 0 }] }, /locale must be a boolean/, "rewrite locale must be a boolean");
await rejects({ headers: [{ source: "/a", headers: { "x-a": "1" }, locale: null }] }, /locale must be a boolean/, "headers locale must be a boolean");
await rejects({ i18n: { locales: ["en"], defaultLocale: "ja" } }, /defaultLocale/, "defaultLocale outside locales");
await rejects({ i18n: { locales: ["en", "en_US"], defaultLocale: "en" } }, /locale tag/, "malformed locale tag");
await rejects({ i18n: { locales: ["en", "EN"], defaultLocale: "en" } }, /twice/, "duplicate locale");
await rejects({ i18n: { locales: [], defaultLocale: "en" } }, /non-empty/, "no locales");
await rejects({ images: { remotePatterns: [{ hostname: "*.evil*.com" }] } }, /hostname/, "wildcard in the middle of a host");
await rejects({ images: { remotePatterns: [{ hostname: "a.com", protocol: "ftp" }] } }, /protocol/, "ftp remote pattern");
await rejects({ images: { remotePatterns: [{ hostname: "a.com", pathname: "photos" }] } }, /pathname/, "relative pathname");

console.log(failed ? `\nRULES TEST FAILED (${failed})` : "\nRULES TEST PASSED");
process.exit(failed ? 1 : 0);
