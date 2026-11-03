// Web-standard fetch handler factory for Edge. Uses neither node:http nor runtime file imports;
// routes/islands/manifest arrive as maps statically imported at build time.

import { options } from "preact";
import { handleRequest } from "./handler.mjs";
import { wrapIsland } from "./island-directive.mjs";
import { prodDocument, prodShell } from "./document.mjs";

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
  return new Response(body, { status: result.status ?? 200, headers });
}

function installIslandHook(registry) {
  const prev = options.vnode;
  options.vnode = (vnode) => {
    if (
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
///   routeTable       : scanRoutes equivalent (file is a key of modules)
/// Returns `(request) => Promise<Response>`.
export function createFetchHandler({
  manifest,
  modules,
  islandComponents,
  routeTable,
  serverFunctions: serverFnTable,
}) {
  const registry = new Map();
  for (const [name, comp] of Object.entries(islandComponents ?? {})) {
    if (typeof comp === "function") {
      registry.set(comp, { name, src: `/_nowaki/${manifest.islands?.[name] ?? ""}` });
    }
  }
  installIslandHook(registry);

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
