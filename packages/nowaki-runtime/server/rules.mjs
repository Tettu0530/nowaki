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

/// Compiles a normalized routing config. Returns null when nothing needs checking per request
/// (no basePath, trailingSlash "ignore", no rules). Throws on an invalid config.
export function compileRules(config) {
  const c = config ?? {};
  const base = c.basePath ?? "";
  const trailing = c.trailingSlash ?? "ignore";
  const redirects = c.redirects ?? [];
  const rewrites = c.rewrites ?? [];
  const headers = c.headers ?? [];
  if (!base && trailing === "ignore" && !redirects.length && !rewrites.length && !headers.length) {
    return null;
  }
  checkBasePath(base);
  if (!["never", "always", "ignore"].includes(trailing)) {
    throw new Error(`trailingSlash must be "never", "always" or "ignore" (got ${JSON.stringify(trailing)})`);
  }
  return {
    base,
    trailing,
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
      return { segs, pairs };
    }),
  };
}

/// What a request becomes: { redirect: { status, location } }, { rewrite: path } (the internal
/// route path), { pass: path } (the route path: the request path without basePath), or
/// { notFound: true } (outside basePath). `path` is the raw (percent-encoded) pathname. A
/// redirect's location doesn't carry the request's query; the caller appends it.
export function applyRules(rules, method, path) {
  if (!rules) return { pass: path };
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
  const redirect = findRule(rules.redirects, decoded);
  if (redirect) {
    const { rule, params } = redirect;
    const dest = rule.dest;
    const path = substitute(dest.segs, params);
    let location;
    if (!dest.origin) location = browserPath(rules, path, dest.slash) + dest.tail;
    else if (dest.bare) location = dest.origin + dest.tail;
    else location = dest.origin + path + (dest.slash ? "/" : "") + dest.tail;
    return guard({ redirect: { status: rule.status, location } });
  }
  const rewrite = findRule(rules.rewrites, decoded);
  if (rewrite) return guard({ rewrite: substitute(rewrite.rule.dest.segs, rewrite.params) });
  return { pass: p };
}

/// The config headers for a request path, in rule order: [[name, value]], a later rule winning
/// for the same name (in the first one's position).
export function ruleHeaders(rules, path) {
  if (!rules || !rules.headers.length) return [];
  const strip = stripBase(rules, path);
  const decoded = strip && decodeParts(strip.p);
  if (!decoded) return [];
  const out = [];
  for (const h of rules.headers) {
    if (!matchSegments(h.segs, decoded)) continue;
    for (const [k, v] of h.pairs) {
      const i = out.findIndex((e) => e[0] === k);
      if (i >= 0) out[i] = [k, v];
      else out.push([k, v]);
    }
  }
  return out;
}

/// encodeURIComponent, with "." and ".." escaped so a capture can't step up a directory.
export function encodeSegment(s) {
  if (s === ".") return "%2E";
  if (s === "..") return "%2E%2E";
  return encodeURIComponent(s);
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
export function browserPath(rules, path, slash) {
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
  const patterns = [];
  const rules = list.map((r, index) => {
    const segs = compileSource(r.source, kind);
    const rule = { index, segs, ...target(r, segs) };
    if (segs.every((s) => s.lit !== undefined)) {
      const key = segs.map((s) => s.lit).join("/");
      if (!literals.has(key)) literals.set(key, index);
    } else {
      patterns.push(rule);
    }
    return rule;
  });
  return { rules, literals, patterns };
}

// First matching rule in config order: a literal source by one map lookup, patterns in order.
function findRule(set, decoded) {
  if (!set.rules.length) return null;
  let best = -1;
  // A literal segment never holds "/", so a decoded %2F can't match one.
  if (set.literals.size && !decoded.some((p) => p.includes("/"))) best = set.literals.get(decoded.join("/")) ?? -1;
  for (const rule of set.patterns) {
    if (best >= 0 && rule.index > best) break;
    const params = matchSegments(rule.segs, decoded);
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
