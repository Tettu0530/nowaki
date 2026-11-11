// Production document assembly. Pure string processing with no node deps, so it works on Edge too.

// Prefers meta resolved after the loader, falling back to the route's static export.
// `htmlAttrs` / `bodyAttrs` come back as attribute strings (with a leading space, escaped) for the
// <html> / <body> tags; meta carries them already merged across layouts (handler.mjs
// `withDocAttrs`), and a page rendered without that (404 / 500) uses its own exports.
export function pageMeta(meta, mod) {
  const str = (v) => (typeof v === "string" ? v : undefined);
  const html = isAttrs(meta?.htmlAttrs) ? meta.htmlAttrs : isAttrs(mod?.htmlAttrs) ? mod.htmlAttrs : {};
  const body = isAttrs(meta?.bodyAttrs) ? meta.bodyAttrs : isAttrs(mod?.bodyAttrs) ? mod.bodyAttrs : {};
  return {
    title: str(meta?.title) ?? str(mod?.title) ?? "Nowaki App",
    head: str(meta?.head) ?? str(mod?.head) ?? "",
    // `export const lang` / meta().lang win; htmlAttrs.lang (say, from a layout) is the fallback.
    lang: str(meta?.lang) ?? str(mod?.lang) ?? attrValue(html.lang) ?? "en",
    htmlAttrs: Object.isFrozen(html) ? frozenHtmlAttrs(html) : attrString(html, ["lang"]),
    bodyAttrs: attrString(body, []),
  };
}

// A frozen htmlAttrs object (handler.mjs gives every page of a locale the same one) can't change,
// so its attribute string is built once.
const frozenHtml = new WeakMap();
function frozenHtmlAttrs(html) {
  let s = frozenHtml.get(html);
  if (s === undefined) frozenHtml.set(html, (s = attrString(html, ["lang"])));
  return s;
}

const isAttrs = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const attrValue = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
// Plain attribute names only, and no inline event handlers (`onload` and the like): they would
// run outside the CSP nonce and aren't something a page should set from data.
const ATTR_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;
const allowedName = (n) => ATTR_NAME.test(n) && !/^on/i.test(n) && n.toLowerCase() !== "data-nowaki-attrs";

/// Merges attribute objects left to right (later wins; `false` / `null` remove one set earlier).
/// `class` values are joined instead, so a layout's class and a page's class both apply.
export function mergeAttrs(...objs) {
  const out = {};
  for (const o of objs) {
    if (!isAttrs(o)) continue;
    for (const [k, v] of Object.entries(o)) {
      if (k === "class" && attrValue(v) !== undefined && attrValue(out.class) !== undefined) {
        out.class = `${out.class} ${attrValue(v)}`;
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

/// ` name="value"` pairs, plus `data-nowaki-attrs` naming them so the SPA router can swap exactly
/// these on navigation (and leave attributes that client code set alone).
function attrString(obj, skip) {
  const names = [];
  let s = "";
  for (const [k, v] of Object.entries(obj)) {
    if (skip.includes(k) || !allowedName(k)) continue;
    if (v === true) s += ` ${k}`;
    else if (attrValue(v) !== undefined) s += ` ${k}="${escapeHtml(attrValue(v))}"`;
    else continue;
    names.push(k);
  }
  return names.length ? `${s} data-nowaki-attrs="${escapeHtml(names.join(" "))}"` : "";
}

// Non-streaming: scan the whole body and put preloads for used islands in <head> (avoids waterfalls).
// `opts.live === false` (static output from `nowaki prerender`): live islands keep their first
// HTML but ship no live.js. A static host has no server to answer its events. `opts.assetBase`:
// where the client files are served (`/_nowaki/`, or `<basePath>/_nowaki/`).
export function prodDocument(manifest, { mod, body, meta }, opts = {}) {
  const m = pageMeta(meta, mod);
  const a = opts.assetBase ?? "/_nowaki/";
  const islandNames = [...body.matchAll(/<nowaki-island name="([^"]+)"/g)].map((m) => m[1]);
  // `meta.router` (handler.mjs): a slot on the page intercepts URLs, so it needs the runtime's
  // router even without islands.
  const hasIslands = (islandNames.length > 0 || meta?.router === true) && manifest.runtime;
  const preloadFiles = [];
  if (hasIslands) {
    const entryChunks = [
      manifest.runtime,
      ...islandNames.map((n) => manifest.islands?.[n]).filter(Boolean),
    ];
    const seen = new Set();
    for (const chunk of entryChunks) {
      if (!seen.has(chunk)) {
        seen.add(chunk);
        preloadFiles.push(chunk);
      }
      for (const dep of manifest.preload?.[chunk] ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          preloadFiles.push(dep);
        }
      }
    }
  }
  const preload = preloadFiles
    .map((f) => `<link rel="modulepreload" href="${a}${f}" />`)
    .join("\n");
  const runtime = hasIslands
    ? `<script id="nowaki-runtime" type="module" src="${a}${manifest.runtime}"${dataRouter(manifest, a)}></script>`
    : "";
  // Only `nowaki dev` / `nowaki start` terminate the /__nowaki/live WebSocket, and they assemble
  // their own documents, so this one tells live.js to go straight to POST /__nowaki/live-event.
  const live =
    opts.live !== false && manifest.liveRuntime && body.includes("<nowaki-live")
      ? `<script id="nowaki-live" type="module" src="${a}${manifest.liveRuntime}" data-live-transport="post"></script>`
      : "";

  return `<!DOCTYPE html>
<html lang="${escapeHtml(m.lang)}"${m.htmlAttrs}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(m.title)}</title>
<meta name="nowaki-head" content="start" />
${preload}
${m.head}
<meta name="nowaki-head" content="end" />
</head>
<body${m.bodyAttrs}>
${body}
${runtime}
${live}
</body>
</html>`;
}

// Streaming: islands aren't known when the shell is sent, so skip per-island preloads
// and preload only the runtime chunk (the runtime finds <nowaki-island> and fetches each island).
export function prodShell(manifest, mod, meta, opts = {}) {
  const m = pageMeta(meta, mod);
  const a = opts.assetBase ?? "/_nowaki/";
  const runtimeChunk = manifest.runtime;
  const runtimePreload = runtimeChunk
    ? `<link rel="modulepreload" href="${a}${runtimeChunk}" />\n`
    : "";
  const runtimeScript = runtimeChunk
    ? `<script id="nowaki-runtime" type="module" src="${a}${runtimeChunk}"${dataRouter(manifest, a)}></script>`
    : "";
  const head = `<!DOCTYPE html>
<html lang="${escapeHtml(m.lang)}"${m.htmlAttrs}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(m.title)}</title>
<meta name="nowaki-head" content="start" />
${runtimePreload}${m.head}
<meta name="nowaki-head" content="end" />
</head>
<body${m.bodyAttrs}>
`;
  const tail = `
${runtimeScript}
</body>
</html>`;
  return { head, tail };
}

// islands.js lazily imports the SPA router from this URL when idle.
function dataRouter(manifest, assetBase) {
  return manifest.routerRuntime ? ` data-router="${assetBase}${manifest.routerRuntime}"` : "";
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
