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
    htmlAttrs: attrString(html, ["lang"]),
    bodyAttrs: attrString(body, []),
  };
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
// HTML but ship no live.js. A static host has no server to answer its events.
export function prodDocument(manifest, { mod, body, meta }, opts = {}) {
  const m = pageMeta(meta, mod);
  const islandNames = [...body.matchAll(/<nowaki-island name="([^"]+)"/g)].map((m) => m[1]);
  const hasIslands = islandNames.length > 0 && manifest.runtime;
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
    .map((f) => `<link rel="modulepreload" href="/_nowaki/${f}" />`)
    .join("\n");
  const runtime = hasIslands
    ? `<script id="nowaki-runtime" type="module" src="/_nowaki/${manifest.runtime}"${dataRouter(manifest)}></script>`
    : "";
  // Only `nowaki dev` / `nowaki start` terminate the /__nowaki/live WebSocket, and they assemble
  // their own documents, so this one tells live.js to go straight to POST /__nowaki/live-event.
  const live =
    opts.live !== false && manifest.liveRuntime && body.includes("<nowaki-live")
      ? `<script type="module" src="/_nowaki/${manifest.liveRuntime}" data-live-transport="post"></script>`
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
export function prodShell(manifest, mod, meta) {
  const m = pageMeta(meta, mod);
  const runtimeChunk = manifest.runtime;
  const runtimePreload = runtimeChunk
    ? `<link rel="modulepreload" href="/_nowaki/${runtimeChunk}" />\n`
    : "";
  const runtimeScript = runtimeChunk
    ? `<script id="nowaki-runtime" type="module" src="/_nowaki/${runtimeChunk}"${dataRouter(manifest)}></script>`
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
function dataRouter(manifest) {
  return manifest.routerRuntime ? ` data-router="/_nowaki/${manifest.routerRuntime}"` : "";
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
