// Config-level routing rules (nowaki.config `basePath`, `trailingSlash`, `redirects`,
// `rewrites`, `headers`), compiled from the normalized config in dist/server/routing.json.
// Runtime-neutral (no node: imports). The same compiler and matcher live in Rust
// (nowaki-core rules.rs); crates/nowaki-core/tests/fixtures/rules-cases.json drives both.
//
// Sources and destinations use the route segment grammar (segments.mjs): /blog/[slug],
// /docs/[...rest], /og/[card].png. Sources compare against percent-decoded segments; captures
// are percent-encoded per segment when substituted, so a capture can never add a "/" or "\"
// to a path, and an external destination's host is always a config literal.

import { decodeSegment, matchSegments, parseSegment } from "./segments.mjs";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Printable ASCII without space and backslash: what a destination may contain as written.
const DEST_CHARS = /^[!-[\]-~]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/// The cookie remembering a visitor's explicit locale choice; it wins over Accept-Language.
export const LOCALE_COOKIE = "nowaki_locale";
// Accept-Language bounds: a longer value counts as absent; ranges past the 32nd are ignored.
const MAX_ACCEPT_LANGUAGE = 4096;
const MAX_LANGUAGE_RANGES = 32;
const LANGUAGE_RANGE = /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/;
const QVALUE = /^[qQ]=(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

/// Compiles a normalized routing config. Returns null when nothing needs checking per request
/// (no basePath, trailingSlash "ignore", no rules, no locale detection). Throws on an invalid
/// config.
export function compileRules(config) {
  const c = config ?? {};
  const base = c.basePath ?? "";
  const trailing = c.trailingSlash ?? "ignore";
  const redirects = c.redirects ?? [];
  const rewrites = c.rewrites ?? [];
  const headers = c.headers ?? [];
  const detect = c.i18n?.detect === true ? compileDetect(c.i18n) : null;
  const plain = !base && trailing === "ignore" && !redirects.length && !rewrites.length && !headers.length;
  if (plain && !detect) return null;
  checkBasePath(base);
  if (!["never", "always", "ignore"].includes(trailing)) {
    throw new Error(`trailingSlash must be "never", "always" or "ignore" (got ${JSON.stringify(trailing)})`);
  }
  return {
    base,
    trailing,
    detect,
    // i18n: rule sources match the route path without its locale prefix.
    locales: c.i18n ? compileLocales(c.i18n) : null,
    // Locale detection alone: applyRules passes every request through.
    plain,
    redirects: compileSet(redirects, "redirects", (r, segs) => {
      const status = r.status ?? 307;
      if (!REDIRECT_STATUS.has(status)) throw new Error(`redirect status must be 301, 302, 303, 307 or 308 (got ${status})`);
      return { status, dest: compileDestination(r.destination, segs, true) };
    }),
    rewrites: compileSet(rewrites, "rewrites", (r, segs) => ({ dest: compileDestination(r.destination, segs, false) })),
    headers: headers.map((h) => {
      const segs = compileSource(h.source);
      const pairs = (h.headers ?? []).map(({ key, value }) => {
        if (typeof key !== "string" || !TOKEN.test(key)) throw new Error(`invalid header name ${JSON.stringify(key)}`);
        if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
          throw new Error(`header ${key}: the value must be a string without CR, LF or NUL`);
        }
        return [key.toLowerCase(), value];
      });
      return { segs, pairs, raw: h.locale === false };
    }),
  };
}

/// What a request becomes: { redirect: { status, location } }, { rewrite: path } (the internal
/// route path), { pass: path } (the route path: the request path without basePath), or
/// { notFound: true } (outside basePath). `path` is the raw (percent-encoded) pathname. A
/// redirect's location doesn't carry the request's query; the caller appends it.
///
/// With i18n configured, sources match the path without its locale prefix (`/ja/login` as
/// `/login`), unless the rule has `locale: false`. An internal redirect destination becomes the
/// destination's URL in the request's locale (no prefix for the default locale unless
/// `prefixDefaultLocale`); a rewrite destination gets the request's locale prefix back, so the
/// renderer sees the locale. A destination whose first segment is a configured locale is left as
/// written.
export function applyRules(rules, method, path) {
  if (!rules || rules.plain) return { pass: path };
  const strip = stripBase(rules, path);
  if (!strip) return { notFound: true };
  const { p, bare } = strip;
  const decoded = decodeParts(p);
  if (!decoded) return { pass: p };
  // Only GET / HEAD are moved to the canonical URL; a POST to /form/ keeps working.
  if (rules.trailing !== "ignore" && (method === "GET" || method === "HEAD")) {
    const last = decoded[decoded.length - 1];
    const dotted = last !== undefined && last.includes(".");
    let move;
    if (rules.trailing === "never") move = rules.base ? !bare && p.endsWith("/") : p.length > 1 && p.endsWith("/");
    else move = rules.base && bare ? true : decoded.length > 0 && !dotted && !p.endsWith("/");
    if (move) {
      const path = decoded.length ? "/" + decoded.map(encodeSegment).join("/") : "/";
      return guard({ redirect: { status: 308, location: browserPath(rules, path, null) } });
    }
  }
  const hit = localeHit(rules, p);
  const localized = hit < 0 ? decoded : decoded.slice(1);
  const redirect = findRule(rules.redirects, localized, decoded);
  if (redirect) {
    const { rule, params } = redirect;
    const dest = rule.dest;
    let path = substitute(dest.segs, params);
    if (!dest.origin && !rule.raw) {
      const l = redirectLocale(rules, hit, dest.segs);
      if (l) path = withLocale(l, path);
    }
    let location;
    if (!dest.origin) location = browserPath(rules, path, dest.slash) + dest.tail;
    else if (dest.bare) location = dest.origin + dest.tail;
    else location = dest.origin + path + (dest.slash ? "/" : "") + dest.tail;
    return guard({ redirect: { status: rule.status, location } });
  }
  const rewrite = findRule(rules.rewrites, localized, decoded);
  if (rewrite) {
    const { rule, params } = rewrite;
    let path = substitute(rule.dest.segs, params);
    if (hit >= 0 && !rule.raw && !startsWithLocale(rules.locales, rule.dest.segs)) path = withLocale(rules.locales.list[hit], path);
    return guard({ rewrite: path });
  }
  return { pass: p };
}

/// The config headers for a request path, in rule order: [[name, value]], a later rule winning
/// for the same name (in the first one's position).
export function ruleHeaders(rules, path) {
  if (!rules || !rules.headers.length) return [];
  const strip = stripBase(rules, path);
  const decoded = strip && decodeParts(strip.p);
  if (!decoded) return [];
  const localized = localeHit(rules, strip.p) < 0 ? decoded : decoded.slice(1);
  const out = [];
  for (const h of rules.headers) {
    if (!matchSegments(h.segs, h.raw ? decoded : localized)) continue;
    for (const [k, v] of h.pairs) {
      const i = out.findIndex((e) => e[0] === k);
      if (i >= 0) out[i] = [k, v];
      else out.push([k, v]);
    }
  }
  return out;
}

/// Whether negotiateLocale answers this request: `i18n.detect` is on and it is a GET or HEAD for
/// the site's root (`/`, or basePath with or without its trailing slash).
export function negotiates(rules, method, path) {
  if (!rules?.detect || (method !== "GET" && method !== "HEAD")) return false;
  return stripBase(rules, path)?.p === "/";
}

/// Accept-Language detection for the site's root (`i18n.detect`): null when it doesn't apply
/// (negotiates), { stay: true } to serve the root (the default locale), or { redirect: { status:
/// 307, location } } to the chosen locale's root. A `nowaki_locale` cookie naming a configured
/// locale decides; otherwise the best configured locale for `acceptLanguage` (RFC 9110 q-values;
/// an exact tag, then the range's primary subtag, then a bare range matching a locale's primary
/// subtag), else the default. The location is built from config strings only. Fronts run this
/// after applyRules passes the request; either way the response varies on Accept-Language and
/// Cookie.
export function negotiateLocale(rules, method, path, acceptLanguage, cookie) {
  if (!negotiates(rules, method, path)) return null;
  const d = rules.detect;
  let chosen = -1;
  const fromCookie = cookie ? localeCookie(cookie) : undefined;
  if (fromCookie !== undefined) chosen = d.locales.indexOf(fromCookie);
  if (chosen < 0 && acceptLanguage) chosen = bestLocale(d, acceptLanguage);
  if (chosen < 0) chosen = d.default;
  if (chosen === d.default && !d.prefixDefault) return { stay: true };
  return { redirect: { status: 307, location: browserPath(rules, `/${d.locales[chosen]}`, false) } };
}

/// encodeURIComponent, with "." and ".." escaped so a capture can't step up a directory.
export function encodeSegment(s) {
  if (s === ".") return "%2E";
  if (s === "..") return "%2E%2E";
  return encodeURIComponent(s);
}

function compileDetect(i18n) {
  const locales = i18n.locales ?? [];
  // The locales end up in a Location header: plain tags only (site-config.mjs checks the shape).
  for (const l of locales) {
    if (typeof l !== "string" || !/^[A-Za-z0-9-]+$/.test(l)) throw new Error(`i18n.locales: ${JSON.stringify(l)} is not a locale tag`);
  }
  const def = locales.indexOf(i18n.defaultLocale);
  if (def < 0) throw new Error(`i18n.defaultLocale must be one of i18n.locales (got ${JSON.stringify(i18n.defaultLocale)})`);
  return { locales: [...locales], lower: locales.map((l) => l.toLowerCase()), default: def, prefixDefault: i18n.prefixDefaultLocale === true };
}

function compileLocales(i18n) {
  const d = compileDetect(i18n);
  return { list: d.locales, default: d.default, prefixDefault: d.prefixDefault };
}

// The configured locale (an index) the route path `p` starts with, or -1. Compared on the raw first
// segment, as handler.mjs (splitLocale) does, so `/%6Aa/x` and `//ja/x` carry no locale.
function localeHit(rules, p) {
  if (!rules.locales) return -1;
  const end = p.indexOf("/", 1);
  const first = end < 0 ? p.slice(1) : p.slice(1, end);
  return first ? rules.locales.list.indexOf(first) : -1;
}

// The locale prefix an internal redirect destination gets: the request's locale, or none for the
// default locale without prefixDefaultLocale (and without i18n, or when the destination already
// names a locale).
function redirectLocale(rules, hit, segs) {
  const l = rules.locales;
  if (!l || startsWithLocale(l, segs)) return null;
  const i = hit < 0 ? l.default : hit;
  return i !== l.default || l.prefixDefault ? l.list[i] : null;
}

/// Whether a destination's first segment is a configured locale, written literally.
export function startsWithLocale(locales, segs) {
  return segs[0]?.lit !== undefined && locales.list.includes(segs[0].lit);
}

function withLocale(locale, path) {
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}

// The first `nowaki_locale` value of a Cookie header.
function localeCookie(cookie) {
  for (const pair of cookie.split(";")) {
    const eq = pair.indexOf("=");
    if (eq >= 0 && pair.slice(0, eq).trim() === LOCALE_COOKIE) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

// One language range: [lowercased range, q in thousandths], or null when malformed.
function languageRange(part) {
  const bits = part.split(";");
  if (bits.length > 2) return null;
  const range = bits[0].trim();
  let q = 1000;
  if (bits.length === 2) {
    const w = bits[1].trim();
    if (!QVALUE.test(w)) return null;
    q = Math.round(Number(w.slice(2)) * 1000);
  }
  return LANGUAGE_RANGE.test(range) ? [range.toLowerCase(), q] : null;
}

// The configured locale (an index) an Accept-Language value prefers, or -1.
function bestLocale(d, header) {
  if (header.length > MAX_ACCEPT_LANGUAGE) return -1;
  const parsed = header.split(",").slice(0, MAX_LANGUAGE_RANGES).map(languageRange).filter(Boolean);
  // q=0 means "not acceptable": the locale it names exactly is never chosen.
  const allowed = d.lower.map((l) => !parsed.some(([r, q]) => q === 0 && r === l));
  // Array.prototype.sort is stable: equal weights keep the header's order.
  const ranges = parsed.filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);
  const find = (pred) => d.lower.findIndex((l, i) => allowed[i] && pred(l));
  for (const [range] of ranges) {
    if (range === "*") {
      const i = allowed[d.default] ? d.default : find(() => true);
      if (i >= 0) return i;
      continue;
    }
    const primary = range.split("-")[0];
    let i = find((l) => l === range);
    if (i < 0) i = find((l) => l === primary);
    if (i < 0 && primary === range) i = find((l) => l.split("-")[0] === primary);
    if (i >= 0) return i;
  }
  return -1;
}

function stripBase(rules, path) {
  if (!rules.base) return { p: path, bare: false };
  if (path === rules.base) return { p: "/", bare: true };
  if (path.startsWith(rules.base) && path[rules.base.length] === "/") {
    return { p: path.slice(rules.base.length), bare: false };
  }
  return null;
}

function decodeParts(p) {
  const parts = p.split("/").filter(Boolean).map(decodeSegment);
  return parts.includes(null) ? null : parts;
}

// A route path as the browser sees it: basePath in front, the trailing-slash policy applied
// ("ignore" keeps what the destination wrote: `slash`).
function browserPath(rules, path, slash) {
  const root = path === "/";
  let out = root ? rules.base || "/" : rules.base + path;
  const last = root ? "" : path.slice(path.lastIndexOf("/") + 1);
  const add = rules.trailing === "always" ? !last.includes(".") : rules.trailing === "ignore" && slash;
  if (add && !out.endsWith("/")) out += "/";
  return out;
}

// An internal location starts with exactly one "/" ("//x" and "/\x" leave the site).
function guard(outcome) {
  const loc = outcome.redirect ? outcome.redirect.location : outcome.rewrite;
  if (outcome.redirect && /^https?:\/\//.test(loc)) return outcome;
  if (loc[0] !== "/" || loc[1] === "/" || loc[1] === "\\") return { notFound: true };
  return outcome;
}

function compileSet(list, kind, target) {
  const literals = new Map();
  const rawLiterals = new Map();
  const patterns = [];
  const rules = list.map((r, index) => {
    const segs = compileSource(r.source, kind);
    const raw = r.locale === false;
    const rule = { index, segs, raw, ...target(r, segs) };
    if (segs.every((s) => s.lit !== undefined)) {
      const key = segs.map((s) => s.lit).join("/");
      const map = raw ? rawLiterals : literals;
      if (!map.has(key)) map.set(key, index);
    } else {
      patterns.push(rule);
    }
    return rule;
  });
  return { rules, literals, rawLiterals, patterns };
}

// A literal segment never holds "/", so a decoded %2F can't match one.
const lookup = (map, parts) => (map.size && !parts.some((p) => p.includes("/")) ? (map.get(parts.join("/")) ?? -1) : -1);

// First matching rule in config order: a literal source by one map lookup, patterns in order.
// `localized` is `decoded` without its locale prefix (all of it without i18n); `locale: false`
// rules match `decoded`.
function findRule(set, localized, decoded) {
  if (!set.rules.length) return null;
  const a = lookup(set.literals, localized);
  const b = lookup(set.rawLiterals, decoded);
  const best = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  for (const rule of set.patterns) {
    if (best >= 0 && rule.index > best) break;
    const params = matchSegments(rule.segs, rule.raw ? decoded : localized);
    if (params) return { rule, params };
  }
  return best >= 0 ? { rule: set.rules[best], params: {} } : null;
}

function compileSource(source, kind = "headers") {
  if (typeof source !== "string" || source[0] !== "/") {
    throw new Error(`${kind}: source must start with "/" (got ${JSON.stringify(source)})`);
  }
  if (CONTROL.test(source) || /[?#]/.test(source)) {
    throw new Error(`${kind}: source ${JSON.stringify(source)} must be a path without a query, fragment or control characters`);
  }
  const segs = source === "/" ? [] : parsePath(source.slice(1), `${kind}: source ${JSON.stringify(source)}`);
  const names = new Set();
  segs.forEach((s, i) => {
    if (s.rest && i !== segs.length - 1) throw new Error(`${kind}: source ${JSON.stringify(source)}: [...${s.param}] must be the last segment`);
    if (s.param !== undefined) {
      if (names.has(s.param)) throw new Error(`${kind}: source ${JSON.stringify(source)} repeats [${s.param}]`);
      names.add(s.param);
    }
  });
  if (segs[0]?.lit === "__nowaki") throw new Error(`${kind}: source ${JSON.stringify(source)} is under /__nowaki/, which is reserved`);
  return segs;
}

function parsePath(path, label) {
  return path.split("/").map((seg) => {
    if (seg === "") throw new Error(`${label} has an empty segment`);
    return parseSegment(seg);
  });
}

function compileDestination(destination, sourceSegs, external) {
  const label = `destination ${JSON.stringify(destination)}`;
  if (typeof destination !== "string" || !DEST_CHARS.test(destination)) {
    throw new Error(`${label} must be printable ASCII without spaces or backslashes (percent-encode the rest)`);
  }
  let origin = "";
  let rest = destination;
  const abs = destination.match(/^(https?:\/\/)([^/?#]*)/);
  if (abs) {
    if (!external) throw new Error(`rewrites: ${label} must be a path starting with "/" (rewrites are internal)`);
    if (!abs[2] || /[[\]]/.test(abs[2])) throw new Error(`${label} needs a literal host`);
    origin = abs[0];
    rest = destination.slice(origin.length);
  } else if (destination[0] !== "/" || destination[1] === "/") {
    throw new Error(`${label} must start with "/" or http(s)://`);
  }
  const cut = rest.search(/[?#]/);
  const pathPart = cut < 0 ? rest : rest.slice(0, cut);
  const tail = cut < 0 ? "" : rest.slice(cut);
  if (tail && !external) throw new Error(`rewrites: ${label} can't have a query or fragment`);
  if (/[[\]]/.test(tail)) throw new Error(`${label}: [params] can only be used in the path`);
  const trimmed = pathPart.replace(/^\/|\/$/g, "");
  const segs = trimmed === "" ? [] : parsePath(trimmed, label);
  if (!origin && segs[0]?.lit === "__nowaki") throw new Error(`${label} is under /__nowaki/, which is reserved`);
  for (const s of segs) {
    if (s.param === undefined) continue;
    const from = sourceSegs.find((x) => x.param === s.param);
    if (!from) throw new Error(`${label} uses [${s.param}], which the source doesn't have`);
    if (!!from.rest !== !!s.rest) {
      throw new Error(`${label}: [${s.rest ? "..." : ""}${s.param}] must be used as written in the source`);
    }
  }
  return { origin, segs, tail, bare: pathPart === "", slash: pathPart.length > 1 && pathPart.endsWith("/") };
}

function substitute(segs, params) {
  if (!segs.length) return "/";
  const out = [];
  for (const s of segs) {
    if (s.lit !== undefined) out.push(s.lit);
    else if (s.rest) out.push(...params[s.param].map(encodeSegment));
    else out.push(encodeSegment(params[s.param]) + (s.suffix ?? ""));
  }
  return "/" + out.join("/");
}

function checkBasePath(base) {
  if (!base) return;
  const ok =
    base[0] === "/" &&
    !base.endsWith("/") &&
    base
      .slice(1)
      .split("/")
      .every((s) => /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/.test(s) && s !== "." && s !== "..");
  if (!ok) throw new Error(`invalid basePath ${JSON.stringify(base)}`);
  if (base === "/__nowaki" || base.startsWith("/__nowaki/")) {
    throw new Error("basePath can't be under /__nowaki/, which is reserved");
  }
}
