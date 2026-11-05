// Web-standard fetch handler factory for Edge. Uses neither node:http nor runtime file imports;
// routes/islands/manifest arrive as maps statically imported at build time.

import { h, options } from "preact";
import { handleRequest } from "./handler.mjs";
import { wrapIsland } from "./island-directive.mjs";
import { prodDocument, prodShell } from "./document.mjs";
import { withSecurityHeaders } from "./security-headers.mjs";
import { applyCsp } from "./csp.mjs";

export function resultToResponse(result) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, String(item));
    } else if (v !== undefined && v !== null) {
      headers.set(k, String(v));
    }
  }
  const body = result.stream ?? result.body ?? "";
  return withSecurityHeaders(new Response(body, { status: result.status ?? 200, headers }));
}

// Same rule as live.mjs liveInitialState, without its node:crypto import.
function initialState(mod, props) {
  const init = mod.live?.state;
  if (typeof init === "function") return init(props ?? {});
  if (init && typeof init === "object") return init;
  return {};
}

let liveCounter = 0;

function installIslandHook(registry, liveRegistry, live) {
  const prev = options.vnode;
  options.vnode = (vnode) => {
    if (typeof vnode.type === "function" && liveRegistry.has(vnode.type) && !vnode.props.__nowakiLiveInner) {
      const { name, mod } = liveRegistry.get(vnode.type);
      const Original = vnode.type;
      vnode.type = (props) => {
        const { state: propState, ...rest } = props;
        const state = propState ?? (live?.initial ?? initialState)(mod, rest);
        const inner = h(Original, { state: live?.view ? live.view(mod, state) : state, __nowakiLiveInner: true });
        // Without the signing helpers (an older worker entry) the island stays on its initial SSR.
        return live ? h("nowaki-live", live.props(name, `L${liveCounter++}`, state), inner) : inner;
      };
    } else if (
      typeof vnode.type === "function" &&
      registry.has(vnode.type) &&
      !vnode.props.__nowakiInner
    ) {
      const island = registry.get(vnode.type);
      const Original = vnode.type;
      vnode.type = (props) => wrapIsland(island, props, Original);
    }
    if (prev) prev(vnode);
  };
}

/// Creates a fetch handler for Edge.
///   manifest         : client manifest (islands/runtime/preload)
///   modules          : route table file key → statically imported module namespace
///   islandComponents : island name → component (default export)
///   liveIslands      : live island name → module namespace (default export + `live`)
///   routeTable       : scanRoutes equivalent (file is a key of modules)
///   live             : { render: liveRender, props: liveProps } when there are live islands. Passed
///                      in by the worker entry so this module never imports node:crypto itself.
/// Returns `(request) => Promise<Response>`.
export function createFetchHandler({
  manifest,
  modules,
  islandComponents,
  liveIslands,
  routeTable,
  serverFunctions: serverFnTable,
  live,
}) {
  const registry = new Map();
  for (const [name, comp] of Object.entries(islandComponents ?? {})) {
    if (typeof comp === "function") {
      registry.set(comp, { name, src: `/_nowaki/${manifest.islands?.[name] ?? ""}` });
    }
  }
  const liveRegistry = new Map();
  const liveByName = new Map();
  for (const [name, mod] of Object.entries(liveIslands ?? {})) {
    if (typeof mod?.default === "function") {
      liveRegistry.set(mod.default, { name, mod });
      liveByName.set(name, mod);
    }
  }
  installIslandHook(registry, liveRegistry, live);

  const serverFunctions =
    serverFnTable && Object.keys(serverFnTable).length
      ? {
          lookup: (id) => serverFnTable[id] ?? null,
          importModule: (key) => modules[key],
        }
      : null;

  const env = {
    dev: false,
    routeTable: () => routeTable,
    importModule: (key) => modules[key],
    ensureIslands: () => {},
    serverFunctions,
    live:
      live && liveByName.size
        ? { lookup: (name) => liveByName.get(name) ?? null, render: live.render }
        : null,
    renderDocument: (args) => prodDocument(manifest, args),
    renderShell: ({ mod, meta }) => prodShell(manifest, mod, meta),
    routeCss: (key) => (manifest.routeCss?.[key] ?? []).map((f) => `/_nowaki/${f}`),
    renderError: (err) => {
      console.error("[nowaki]", err);
      return {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "Internal Server Error",
      };
    },
  };

  return async (request) => {
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    // Web Requests may omit Host; the same-origin checks (actions, RPC) need it, and the URL has it.
    if (!headers.host) headers.host = url.host;
    const result = await handleRequest(env, {
      method: request.method,
      url,
      version: "prod",
      headers,
      readBody: async () => new Uint8Array(await request.arrayBuffer()),
    });
    return resultToResponse(applyCsp(result));
  };
}
