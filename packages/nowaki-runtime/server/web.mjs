// Edge 向けの Web 標準 fetch ハンドラ工場。node:http も実行時ファイル import も使わず、
// ルート/島/manifest はビルド時に静的 import 済みのマップとして受け取る。

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

/// Edge 用の fetch ハンドラを作る。
///   manifest         : クライアント manifest（islands/runtime/preload）
///   modules          : ルートテーブルの file キー → 静的 import 済みモジュール名前空間
///   islandComponents : island 名 → コンポーネント実体（default export）
///   routeTable       : scanRoutes 相当（file は modules のキー）
/// 返り値は `(request) => Promise<Response>`。
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
    renderError: (err) => ({
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: String(err?.stack ?? err),
    }),
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
