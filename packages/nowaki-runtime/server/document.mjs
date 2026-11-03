// Production document assembly. Pure string processing with no node deps, so it works on Edge too.

// Prefers meta resolved after the loader, falling back to the route's static export.
export function pageMeta(meta, mod) {
  const str = (v) => (typeof v === "string" ? v : undefined);
  return {
    title: str(meta?.title) ?? str(mod?.title) ?? "Nowaki App",
    head: str(meta?.head) ?? str(mod?.head) ?? "",
    lang: str(meta?.lang) ?? str(mod?.lang) ?? "en",
  };
}

// Non-streaming: scan the whole body and put preloads for used islands in <head> (avoids waterfalls).
export function prodDocument(manifest, { mod, body, meta }) {
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
  // Adapter outputs have no live transport (/__nowaki/live terminates in the Rust server), so live
  // islands stay on their initial SSR and live.js isn't shipped.

  return `<!DOCTYPE html>
<html lang="${escapeHtml(m.lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(m.title)}</title>
<meta name="nowaki-head" content="start" />
${preload}
${m.head}
<meta name="nowaki-head" content="end" />
</head>
<body>
${body}
${runtime}
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
<html lang="${escapeHtml(m.lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(m.title)}</title>
<meta name="nowaki-head" content="start" />
${runtimePreload}${m.head}
<meta name="nowaki-head" content="end" />
</head>
<body>
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
