// Web-standard fetch handler factory for Edge. Uses neither node:http nor runtime file imports;
// routes/islands/manifest arrive as maps statically imported at build time.

import { h, options } from "preact";
import { handleRequest } from "./handler.mjs";
import { wrapIsland } from "./island-directive.mjs";
import { prodDocument, prodShell } from "./document.mjs";
import { withSecurityHeaders } from "./security-headers.mjs";

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

function installIslandHook(registry, liveRegistry) {
  const prev = options.vnode;
  options.vnode = (vnode) => {
    if (typeof vnode.type === "function" && liveRegistry.has(vnode.type) && !vnode.props.__nowakiLiveInner) {
      // No live transport on Edge yet: render the island once with its initial state.
      const mod = liveRegistry.get(vnode.type);
      const Original = vnode.type;
      vnode.type = (props) => {
        const { state: propState, ...rest } = props;
        return h(Original, { state: propState ?? initialState(mod, rest), __nowakiLiveInner: true });
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
/// Returns `(request) => Promise<Response>`.
export function createFetchHandler({
  manifest,
  modules,
  islandComponents,
  liveIslands,
  routeTable,
  serverFunctions: serverFnTable,
}) {
  const registry = new Map();
  for (const [name, comp] of Object.entries(islandComponents ?? {})) {
    if (typeof comp === "function") {
      registry.set(comp, { name, src: `/_nowaki/${manifest.islands?.[name] ?? ""}` });
    }
  }
  const liveRegistry = new Map();
  for (const mod of Object.values(liveIslands ?? {})) {
    if (typeof mod?.default === "function") liveRegistry.set(mod.default, mod);
  }
  installIslandHook(registry, liveRegistry);

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
    renderDocument: (args) => prodDocument(manifest, args),
    renderShell: ({ mod, meta }) => prodShell(manifest, mod, meta),
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
    return resultToResponse(result);
  };
}
