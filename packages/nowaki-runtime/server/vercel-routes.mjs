// nowaki.config `redirects` and `headers` as Vercel Build Output API routes (config.json), so
// Vercel answers a redirect without starting the function and puts the headers on static files.
// Generated from the compiled rules (rules.mjs). Everything else (basePath, trailingSlash,
// rewrites, and any redirect not expressible here) stays in the function, which runs the same
// rules (app.mjs), so a request a native route declines still gets the right answer.
//
// A native redirect must never answer differently from the function. Captures therefore accept
// only characters encodeURIComponent leaves alone (so substituting them raw equals the function's
// per-segment encoding, whether Vercel matches the raw or the decoded path), never a "." / ".."
// segment, and never an empty segment; a request outside that falls through to the function.
// Routes are emitted in config order and stop at the first rule that can't be expressed, so a
// later native rule never answers a request an earlier rule owns. scripts/rules-front-test.mjs
// checks every redirect in the shared rules fixture against applyRules.

const SAFE = "[A-Za-z0-9\\-_.!~*'()]";
const SAFE_TEXT = /^[A-Za-z0-9\-_.!~*'()]+$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/// One captured segment: SAFE characters, but not "." or ".." once `suffix` is removed.
const segment = (suffix = "") => `(?!\\.\\.?${esc(suffix)}(?:/|$))${SAFE}+`;

/// Routes for the redirects, in order, up to the first one only the function can answer.
export function vercelRedirects(rules) {
  const out = [];
  if (!rules) return out;
  for (const rule of rules.redirects.rules) {
    const route = redirectRoute(rules, rule);
    if (!route) break;
    out.push(route);
  }
  return out;
}

/// Routes adding the config headers (`continue: true`, later rules overriding earlier ones).
export function vercelHeaders(rules) {
  if (!rules) return [];
  return rules.headers.map(({ segs, pairs }) => {
    const parts = segs.map((s) => {
      if (s.lit !== undefined) return "/" + esc(encodeURIComponent(s.lit));
      if (s.rest) return "/[^/]+(?:/[^/]+)*";
      return "/[^/]+" + esc(s.suffix ?? "");
    });
    const body = parts.join("");
    // Never on the framework's /__nowaki/* endpoints (the client reaches them under basePath).
    const src = rules.base ? `^${esc(rules.base)}(?!/__nowaki/)${body}/?$` : body ? `^(?!/__nowaki/)${body}/?$` : "^/$";
    return { src, headers: Object.fromEntries(pairs), continue: true };
  });
}

function redirectRoute(rules, rule) {
  const { dest } = rule;
  // A destination query would need merging with the request's; `$` would read as a capture.
  if (dest.tail || dest.origin.includes("$")) return null;
  const names = new Map();
  let src = "";
  for (const s of rule.segs) {
    if (s.lit !== undefined) {
      if (!SAFE_TEXT.test(s.lit) || s.lit === "." || s.lit === "..") return null;
      src += "/" + esc(s.lit);
      continue;
    }
    if (s.suffix !== undefined && !SAFE_TEXT.test(s.suffix)) return null;
    const name = `n${names.size}`;
    names.set(s.param, name);
    src += s.rest
      ? `/(?<${name}>${segment()}(?:/${segment()})*)`
      : `/(?<${name}>${segment(s.suffix)})${esc(s.suffix ?? "")}`;
  }
  const last = rule.segs[rule.segs.length - 1];
  const dottedLast = last && (last.suffix !== undefined || (last.lit !== undefined && last.lit.includes(".")));
  let end;
  if (rules.trailing === "ignore") end = "/?$";
  else if (rules.trailing === "never") end = "$";
  else end = dottedLast ? "/?$" : "/$";
  const base = esc(rules.base);
  if (!src) {
    // The root: under basePath it's /app (and /app/ unless "never" redirects that first).
    if (!rules.base) src = "^/$";
    else src = `^${base}${rules.trailing === "ignore" ? "/?" : rules.trailing === "always" ? "/" : ""}$`;
  } else {
    src = `^${base}${src}${end}`;
  }

  let path = "";
  for (const s of dest.segs) {
    if (s.lit !== undefined) {
      if (s.lit.includes("$")) return null;
      path += "/" + s.lit;
    } else {
      path += "/$" + names.get(s.param) + (s.suffix ?? "");
    }
  }
  path ||= "/";
  let location;
  if (dest.origin) {
    location = dest.bare ? dest.origin : dest.origin + path + (dest.slash ? "/" : "");
  } else {
    const destLast = dest.segs[dest.segs.length - 1];
    let slash;
    if (rules.trailing === "always") {
      // Whether "always" adds a slash depends on a captured value: leave it to the function.
      if (destLast && destLast.lit === undefined && destLast.suffix === undefined) return null;
      slash = !(destLast?.suffix !== undefined || (destLast?.lit ?? "").includes("."));
    } else {
      slash = rules.trailing === "ignore" && dest.slash;
    }
    location = (path === "/" ? rules.base || "/" : rules.base + path);
    if (slash && !location.endsWith("/")) location += "/";
  }
  return { src, headers: { Location: location }, status: rule.status };
}
