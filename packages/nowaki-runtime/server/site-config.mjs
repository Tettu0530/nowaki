// Prints the build-time parts of nowaki.config as JSON, for `nowaki build` / `nowaki dev`
// (nowaki-core runs no JS): `site` (normalized), `fonts` (as written), `routing` (basePath,
// trailingSlash, redirects, rewrites, headers, i18n: normalized and validated, written to
// dist/server/routing.json) and `images` (remotePatterns).
// Usage: node site-config.mjs   (in the app root)  → {"site":"https://example.com","fonts":[…]}
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileRules } from "./rules.mjs";
import { decodeSegment, parseSegment } from "./segments.mjs";
import { normalizeSite } from "./seo.mjs";

const REDIRECT_STATUS = [301, 302, 303, 307, 308];
const BASE_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const HOSTNAME = /^(\*\*?\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/// The top-level nowaki.config keys. Any other key throws (a typo like `basepath` would otherwise
/// do nothing). api/config.txt lists these, so adding one shows up in review.
export const CONFIG_KEYS = Object.freeze([
  "site",
  "fonts",
  "basePath",
  "trailingSlash",
  "redirects",
  "rewrites",
  "headers",
  "i18n",
  "images",
  "plugins",
]);

/// The keys of a `fonts[]` entry. Every font takes `common`; a Google font (`provider: "google"`)
/// also takes `google`, a local one (`src`) takes `local`, and each entry of an `src` array takes
/// `src`. A key of the other kind, or any other key, throws.
export const FONT_KEYS = Object.freeze({
  common: Object.freeze(["family", "fallback", "variable", "display", "preload"]),
  google: Object.freeze(["provider", "weights", "styles", "subsets"]),
  local: Object.freeze(["src", "weight", "style"]),
  src: Object.freeze(["path", "weight", "style"]),
});

const FONT_FALLBACKS = ["sans-serif", "serif", "monospace"];
const FONT_DISPLAY = ["auto", "block", "swap", "fallback", "optional"];
const FONT_STYLES = ["normal", "italic"];

/// The config object of an imported nowaki.config module: its default export. The old
/// `export const config` alias was removed in 0.20.0; a module that only has it throws, so the
/// config isn't silently empty.
export function configOf(mod) {
  if (mod.default !== undefined) return mod.default ?? {};
  if (mod.config !== undefined) {
    throw new Error("`export const config` is no longer read (removed in 0.20.0): use `export default { ... }` (or `export default defineConfig({ ... })` from @nowaki-dev/runtime/config)");
  }
  return {};
}

/// The build-time config: `{ site?, fonts?, routing?, images? }`. Throws on an invalid value,
/// including an unknown top-level key. `redirects` / `rewrites` / `headers` may be (async)
/// functions, called once here.
export async function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("the default export must be an object");
  }
  keys(config, CONFIG_KEYS, "", "top-level key");
  const out = {};
  const site = normalizeSite(config.site);
  if (site) out.site = site;
  const fonts = normalizeFonts(config.fonts);
  if (fonts) out.fonts = fonts;
  if (config.plugins !== undefined && config.plugins !== null && !Array.isArray(config.plugins)) {
    throw new Error("plugins must be an array");
  }
  const routing = await normalizeRouting(config);
  if (routing) out.routing = routing;
  const images = normalizeImages(config.images);
  if (images) out.images = images;
  return out;
}

async function normalizeRouting(config) {
  const r = {};
  const base = normalizeBasePath(config.basePath);
  if (base) r.basePath = base;
  const trailing = config.trailingSlash ?? "ignore";
  if (!["never", "always", "ignore"].includes(trailing)) {
    throw new Error(`trailingSlash must be "never", "always" or "ignore" (got ${JSON.stringify(trailing)})`);
  }
  if (trailing !== "ignore") r.trailingSlash = trailing;
  const redirects = (await ruleList(config.redirects, "redirects")).map((x, i) => {
    const label = `redirects[${i}]`;
    keys(x, ["source", "destination", "permanent", "statusCode", "locale"], label);
    if (x.permanent !== undefined && typeof x.permanent !== "boolean") throw new Error(`${label}.permanent must be a boolean`);
    if (x.statusCode !== undefined && !REDIRECT_STATUS.includes(x.statusCode)) {
      throw new Error(`${label}.statusCode must be one of ${REDIRECT_STATUS.join(", ")}`);
    }
    return withLocale(
      {
        source: source(x.source, label),
        destination: destination(x.destination, label),
        status: x.statusCode ?? (x.permanent ? 308 : 307),
      },
      x,
      label,
    );
  });
  const rewrites = (await ruleList(config.rewrites, "rewrites")).map((x, i) => {
    const label = `rewrites[${i}]`;
    keys(x, ["source", "destination", "locale"], label);
    if (typeof x.destination === "string" && /^[a-z][a-z0-9+.-]*:/i.test(x.destination)) {
      throw new Error(`${label}.destination must be a path starting with "/": rewrites are internal (use a redirect for another site)`);
    }
    return withLocale({ source: source(x.source, label), destination: destination(x.destination, label) }, x, label);
  });
  const headers = (await ruleList(config.headers, "headers")).map((x, i) => {
    const label = `headers[${i}]`;
    keys(x, ["source", "headers", "locale"], label);
    return withLocale({ source: source(x.source, label), headers: headerPairs(x.headers, label) }, x, label);
  });
  if (redirects.length) r.redirects = redirects;
  if (rewrites.length) r.rewrites = rewrites;
  if (headers.length) r.headers = headers;
  const i18n = normalizeI18n(config.i18n);
  if (i18n) r.i18n = i18n;
  // The runtime compiler is the final check, so the build refuses what a server would refuse.
  compileRules(r);
  return Object.keys(r).length ? r : undefined;
}

function normalizeBasePath(value) {
  if (value === undefined || value === null || value === "" || value === "/") return undefined;
  if (typeof value !== "string" || value[0] !== "/") {
    throw new Error(`basePath must be a path like "/app" (got ${JSON.stringify(value)})`);
  }
  const base = value.replace(/\/+$/, "");
  for (const seg of base.slice(1).split("/")) {
    if (!BASE_SEGMENT.test(seg) || seg === "." || seg === "..") {
      throw new Error(`basePath ${JSON.stringify(value)}: each segment must be plain URL characters (no brackets, "%" or empty segments)`);
    }
  }
  if (base === "/__nowaki" || base.startsWith("/__nowaki/")) throw new Error("basePath can't be under /__nowaki/, which is reserved");
  return base;
}

async function ruleList(value, name) {
  const list = typeof value === "function" ? await value() : value;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`${name} must be an array (or a function returning one)`);
  for (const [i, x] of list.entries()) {
    if (!x || typeof x !== "object") throw new Error(`${name}[${i}] must be an object`);
  }
  return list;
}

// `locale: false` (match the path with its locale prefix) is kept; the default `true` is left out
// of routing.json.
function withLocale(rule, x, label) {
  if (x.locale === undefined || x.locale === true) return rule;
  if (x.locale !== false) throw new Error(`${label}.locale must be a boolean`);
  rule.locale = false;
  return rule;
}

function keys(obj, allowed, label, what = "key") {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    const near = didYouMean(k, allowed);
    const hint = near ? ` Did you mean ${JSON.stringify(near)}?` : "";
    throw new Error(`${label ? `${label}: ` : ""}unknown ${what} ${JSON.stringify(k)}.${hint} (allowed: ${allowed.join(", ")})`);
  }
}

/// The allowed name closest to `key` (Levenshtein distance, ignoring case) when it is close enough
/// to be a typo: one edit for a short name, up to a third of the name's length for a longer one.
export function didYouMean(key, allowed) {
  const k = String(key).toLowerCase();
  let best = null;
  let bestDist = Infinity;
  for (const a of allowed) {
    const d = levenshtein(k, a.toLowerCase());
    if (d < bestDist) [best, bestDist] = [a, d];
  }
  return bestDist <= Math.max(1, Math.floor(k.length / 3)) ? best : null;
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// `fonts`, checked here so a mistake fails before anything is downloaded (crates/nowaki/src/fonts.rs
// builds them from the entries as written). One shape: a Google font is `{ family, provider:
// "google", weights?, styles?, subsets? }`, a local one `{ family, src: "<file>", weight?, style? }`
// or `{ family, src: [{ path, weight?, style? }] }`; both take `fallback`, `variable`, `display`
// and `preload`.
function normalizeFonts(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("fonts must be an array");
  for (const [i, f] of value.entries()) {
    const at = `fonts[${i}]`;
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error(`${at} must be an object`);
    const google = f.provider !== undefined;
    const mine = google ? FONT_KEYS.google : FONT_KEYS.local;
    const other = google ? FONT_KEYS.local : FONT_KEYS.google;
    for (const k of Object.keys(f)) {
      if (!other.includes(k) || mine.includes(k)) continue;
      const instead = {
        weight: "`weights: [400, 700]`",
        style: '`styles: ["normal", "italic"]`',
        src: "no `src` (drop `provider` for a local font)",
        weights: "`weight` (or one `src` entry per weight)",
        styles: "`style` (or one `src` entry per style)",
        subsets: "no `subsets` (the file is used as it is)",
        provider: "",
      }[k];
      throw new Error(
        google
          ? `${at}: \`${k}\` is for a local font (\`src\`); a Google font takes ${instead}`
          : `${at}: \`${k}\` is for \`provider: "google"\`; a local font takes ${instead}`,
      );
    }
    keys(f, [...FONT_KEYS.common, ...mine], at);
    if (typeof f.family !== "string" || !f.family.trim()) throw new Error(`${at}.family must be a non-empty string`);
    if (google && f.provider !== "google") throw new Error(`${at}.provider must be "google" (got ${JSON.stringify(f.provider)})`);
    if (f.fallback !== undefined && !FONT_FALLBACKS.includes(f.fallback)) {
      throw new Error(`${at}.fallback must be "sans-serif", "serif" or "monospace"`);
    }
    if (f.display !== undefined && !FONT_DISPLAY.includes(f.display)) {
      throw new Error(`${at}.display must be one of ${FONT_DISPLAY.map((d) => JSON.stringify(d)).join(", ")}`);
    }
    if (f.variable !== undefined && (typeof f.variable !== "string" || !/^--[\w-]+$/.test(f.variable))) {
      throw new Error(`${at}.variable must be a CSS custom property name like "--font-body"`);
    }
    if (f.preload !== undefined && typeof f.preload !== "boolean") throw new Error(`${at}.preload must be a boolean`);
    if (google) {
      fontList(f.weights, `${at}.weights`, isWeight, "a weight from 1 to 1000");
      fontList(f.styles, `${at}.styles`, (s) => FONT_STYLES.includes(s), '"normal" or "italic"');
      fontList(f.subsets, `${at}.subsets`, (s) => typeof s === "string" && s !== "", 'a subset name like "latin"');
    } else if (typeof f.src === "string" && f.src) {
      fontFace(f, at);
    } else if (Array.isArray(f.src) && f.src.length) {
      if (f.weight !== undefined || f.style !== undefined) {
        throw new Error(`${at}: with an \`src\` array, put \`weight\` / \`style\` in each entry`);
      }
      for (const [j, e] of f.src.entries()) {
        const l = `${at}.src[${j}]`;
        if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`${l} must be { path, weight, style }`);
        keys(e, FONT_KEYS.src, l);
        if (typeof e.path !== "string" || !e.path) throw new Error(`${l}.path must be the path of a font file`);
        fontFace(e, l);
      }
    } else if (f.src === undefined) {
      throw new Error(`${at}: give \`src\` (a local font file) or \`provider: "google"\``);
    } else {
      throw new Error(`${at}.src must be a file path or a non-empty array of { path, weight, style }`);
    }
  }
  return value.length ? value : undefined;
}

const isWeight = (w) => (typeof w === "number" || (typeof w === "string" && /^\d+$/.test(w))) && Number.isInteger(Number(w)) && Number(w) >= 1 && Number(w) <= 1000;

function fontList(value, label, ok, what) {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a non-empty array`);
  for (const v of value) if (!ok(v)) throw new Error(`${label}: ${JSON.stringify(v)} is not ${what}`);
}

// A local face's `weight` (a number, or a range like "100 900" for a variable font) and `style`.
function fontFace(x, label) {
  const w = x.weight;
  if (w !== undefined && !isWeight(w) && !(typeof w === "string" && /^\d{1,4} \d{1,4}$/.test(w))) {
    throw new Error(`${label}.weight must be a weight from 1 to 1000 or a range like "100 900"`);
  }
  if (x.style !== undefined && !FONT_STYLES.includes(x.style)) throw new Error(`${label}.style must be "normal" or "italic"`);
}

// Literal segments are compared with the decoded request path, so they're stored decoded.
function source(value, label) {
  if (typeof value !== "string" || value[0] !== "/") {
    throw new Error(`${label}.source must be a path starting with "/" (got ${JSON.stringify(value)})`);
  }
  if (value === "/") return value;
  const segs = value.replace(/\/$/, "").slice(1).split("/");
  return "/" + segs.map((s) => (parseSegment(s).lit !== undefined ? (decodeSegment(s) ?? s) : s)).join("/");
}

// Non-ASCII characters and spaces are percent-encoded, so a Location header stays ASCII.
function destination(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`${label}.destination must be a string`);
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${label}.destination ${JSON.stringify(value)} is not a valid URL`);
    }
    const host = value.slice(value.indexOf("//") + 2).split(/[/?#]/)[0];
    if (!url.hostname || /[^\x21-\x7e]/.test(host)) {
      throw new Error(`${label}.destination ${JSON.stringify(value)}: write the host in ASCII (punycode)`);
    }
  } else if (value[0] !== "/" || value[1] === "/" || value[1] === "\\") {
    throw new Error(`${label}.destination must start with "/" or http(s):// (got ${JSON.stringify(value)})`);
  }
  if (/[\r\n\0]/.test(value)) throw new Error(`${label}.destination contains CR, LF or NUL`);
  return value.replace(/[^\x21-\x7e]/gu, (c) => encodeURIComponent(c));
}

function headerPairs(value, label) {
  let pairs;
  if (Array.isArray(value)) {
    pairs = value.map((h, i) => {
      if (!h || typeof h !== "object") throw new Error(`${label}.headers[${i}] must be { key, value }`);
      keys(h, ["key", "value"], `${label}.headers[${i}]`);
      return [h.key, h.value];
    });
  } else if (value && typeof value === "object") {
    pairs = Object.entries(value);
  } else {
    throw new Error(`${label}.headers must be an object of header names to values`);
  }
  if (!pairs.length) throw new Error(`${label}.headers is empty`);
  return pairs.map(([key, v]) => {
    if (typeof v === "number") v = String(v);
    if (typeof key !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) {
      throw new Error(`${label}: ${JSON.stringify(key)} is not a valid header name`);
    }
    if (typeof v !== "string" || /[\r\n\0]/.test(v)) {
      throw new Error(`${label}: the value of ${key} must be a string without CR, LF or NUL`);
    }
    return { key: key.toLowerCase(), value: v };
  });
}

function normalizeI18n(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("i18n must be an object");
  keys(value, ["locales", "defaultLocale", "prefixDefaultLocale", "detect"], "i18n");
  const { locales, defaultLocale } = value;
  if (!Array.isArray(locales) || !locales.length) throw new Error("i18n.locales must be a non-empty array");
  const seen = new Set();
  for (const l of locales) {
    let ok = typeof l === "string" && LOCALE.test(l);
    if (ok) {
      try {
        Intl.getCanonicalLocales(l);
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new Error(`i18n.locales: ${JSON.stringify(l)} is not a locale tag like "en" or "pt-BR"`);
    if (seen.has(l.toLowerCase())) throw new Error(`i18n.locales lists ${JSON.stringify(l)} twice`);
    seen.add(l.toLowerCase());
  }
  if (!locales.includes(defaultLocale)) {
    throw new Error(`i18n.defaultLocale must be one of i18n.locales (got ${JSON.stringify(defaultLocale)})`);
  }
  for (const k of ["prefixDefaultLocale", "detect"]) {
    if (value[k] !== undefined && typeof value[k] !== "boolean") throw new Error(`i18n.${k} must be a boolean`);
  }
  return {
    locales: [...locales],
    defaultLocale,
    prefixDefaultLocale: value.prefixDefaultLocale ?? false,
    detect: value.detect ?? false,
  };
}

function normalizeImages(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("images must be an object");
  keys(value, ["remotePatterns"], "images");
  const list = value.remotePatterns ?? [];
  if (!Array.isArray(list)) throw new Error("images.remotePatterns must be an array");
  const remotePatterns = list.map((p, i) => {
    const label = `images.remotePatterns[${i}]`;
    if (!p || typeof p !== "object") throw new Error(`${label} must be an object`);
    keys(p, ["protocol", "hostname", "port", "pathname"], label);
    const out = {};
    if (p.protocol !== undefined) {
      const protocol = String(p.protocol).replace(/:$/, "");
      if (protocol !== "https" && protocol !== "http") throw new Error(`${label}.protocol must be "https" or "http"`);
      out.protocol = protocol;
    }
    if (typeof p.hostname !== "string" || !HOSTNAME.test(p.hostname.toLowerCase())) {
      throw new Error(`${label}.hostname must be a host name like "images.example.com" ("*." / "**." only as a prefix)`);
    }
    out.hostname = p.hostname.toLowerCase();
    if (p.port !== undefined && p.port !== "") {
      const port = String(p.port);
      if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error(`${label}.port must be a port number`);
      out.port = port;
    }
    if (p.pathname !== undefined) {
      if (typeof p.pathname !== "string" || p.pathname[0] !== "/" || /[\s?#\\]/.test(p.pathname)) {
        throw new Error(`${label}.pathname must be a path glob starting with "/" (like "/photos/**")`);
      }
      out.pathname = p.pathname;
    }
    return out;
  });
  return remotePatterns.length ? { remotePatterns } : undefined;
}

async function main() {
  let out = {};
  for (const name of ["nowaki.config.mjs", "nowaki.config.js"]) {
    const p = path.join(process.cwd(), name);
    if (!existsSync(p)) continue;
    const mod = await import(pathToFileURL(p).href);
    try {
      out = await normalizeConfig(configOf(mod));
    } catch (e) {
      process.stderr.write(`${name}: ${e?.message ?? e}\n`);
      process.exit(1);
    }
    break;
  }
  process.stdout.write(JSON.stringify(out));
}

// Run as a script (the CLI) or imported (tests). node_modules paths are symlinks under pnpm, and
// import.meta.url is the real path.
const entry = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : "";
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
