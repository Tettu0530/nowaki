// Island-aware dev SSR renderer. To avoid AST rewriting on the Rust side, the options.vnode
// hook detects components under islands/ and wraps them in <nowaki-island>.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { h, options } from "preact";

import { wrapIsland } from "./island-directive.mjs";
import { liveInitialState, liveTopics, liveView } from "./live.mjs";
import { liveProps } from "./live-sign.mjs";
import { pageMeta } from "./document.mjs";

const ISLAND_EXT = /\.(tsx|jsx|ts|js|tsrx)$/;

let registry = new Map();
let registryVersion = null;
let liveCounter = 0; // only needs to be unique within a page

export async function loadIslandRegistry(appRoot, version) {
  if (registryVersion === version) return registry;
  const dir = path.join(appRoot, "islands");
  const next = new Map();
  let files = [];
  try {
    files = await readdir(dir);
  } catch {}
  for (const f of files) {
    if (!ISLAND_EXT.test(f)) continue;
    const abs = path.join(dir, f);
    const mod = await import(`${pathToFileURL(abs).href}?v=${version}`);
    if (typeof mod.default !== "function") continue;
    next.set(mod.default, {
      name: f.replace(ISLAND_EXT, ""),
      src: `/islands/${f}`,
      // Islands with `export const live` are server-reactive (no JS sent to the client).
      live: mod.live ?? null,
      mod,
    });
  }
  registry = next;
  registryVersion = version;
  return registry;
}

const prevVnodeHook = options.vnode;
options.vnode = (vnode) => {
  if (
    typeof vnode.type === "function" &&
    registry.has(vnode.type) &&
    !vnode.props.__nowakiInner &&
    !vnode.props.__nowakiLiveInner
  ) {
    const island = registry.get(vnode.type);
    const Original = vnode.type;
    if (island.live) {
      // Live island JS isn't sent to the client (the server re-renders and pushes patches).
      vnode.type = (props) => {
        const { state: propState, ...rest } = props;
        const state = propState ?? liveInitialState(island.mod, rest);
        const nid = `L${liveCounter++}`;
        // liveProps HMAC-signs the initial state (verified on join to reject forged state).
        return h(
          "nowaki-live",
          liveProps(island.name, nid, state, liveTopics(island.mod, state)),
          h(Original, { state: liveView(island.mod, state), __nowakiLiveInner: true }),
        );
      };
    } else {
      vnode.type = (props) => wrapIsland(island, props, Original);
    }
  }
  if (prevVnodeHook) prevVnodeHook(vnode);
};

// Returns head (…<body>) and tail (</body>…). When streaming, the handler pipes the body in between.
// `scripts.islands` / `scripts.live`: whether the page needs the islands runtime (and with it the
// SPA router) and live.js. A streaming shell can't know yet, so it gets both, as in production.
export function renderShell({ mod, meta }, scripts = { islands: true, live: true }) {
  const m = pageMeta(meta, mod);
  const head = `<!DOCTYPE html>
<html lang="${escapeHtml(m.lang)}"${m.htmlAttrs}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(m.title)}</title>
<meta name="nowaki-head" content="start" />
${m.head}
<meta name="nowaki-head" content="end" />
</head>
<body${m.bodyAttrs}>
`;
  const tail = `
${devScripts(scripts)}
</body>
</html>`;
  return { head, tail };
}

// Like production (document.mjs), a page without islands gets no islands runtime and so no SPA
// router (links do full loads in dev too), unless a slot on it intercepts URLs (`meta.router`).
export function renderDocument({ mod, body, meta }) {
  const { head, tail } = renderShell(
    { mod, meta },
    { islands: meta?.router === true || body.includes("<nowaki-island"), live: body.includes("<nowaki-live") },
  );
  return `${head}${body}${tail}`;
}

function devScripts({ islands, live: hasLive }) {
  // As in prod, islands.js lazily imports the SPA router from data-router after hydration.
  const router = islands
    ? '<script id="nowaki-runtime" type="module" src="/node_modules/@nowaki-dev/runtime/client/islands.js" data-router="/node_modules/@nowaki-dev/runtime/client/router.js"></script>\n'
    : "";
  const live = hasLive
    ? '<script id="nowaki-live" type="module" src="/node_modules/@nowaki-dev/runtime/client/live.js"></script>\n'
    : "";
  const hmr =
    '<script type="module" src="/node_modules/@nowaki-dev/runtime/client/hmr.js"></script>';
  return `${router}${live}${hmr}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Includes hmr.js, so it auto-reloads once fixed.
export function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Nowaki — build error</title></head>
<body style="margin:0;background:#0a0c12;color:#e6e6e6;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">
<div style="max-width:920px;margin:0 auto;padding:2.5rem 2rem">
<div style="color:#ff6b6b;font-weight:700;font-size:15px;margin-bottom:1rem">Nowaki — build error</div>
<pre style="white-space:pre-wrap;margin:0">${escapeHtml(message)}</pre>
<div style="margin-top:1.5rem;color:#8a8f98">Fix the error and save; the page reloads automatically.</div>
</div>
<script type="module" src="/node_modules/@nowaki-dev/runtime/client/hmr.js"></script>
</body>
</html>`;
}
