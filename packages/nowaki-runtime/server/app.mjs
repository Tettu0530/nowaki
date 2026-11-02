// 本番アプリの中核。`nowaki start` と各アダプタの自己完結エントリが共有する。
// clientDir / serverDir を引数で受けるので、cwd にも import.meta の位置にも縛られない。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { h, options } from "preact";
import { loadEnv } from "./env.mjs";
import { wrapIsland } from "./island-directive.mjs";
import { scanRoutes } from "./router.mjs";
import { handleRequest, sendResult } from "./handler.mjs";
import { prodDocument, prodShell } from "./document.mjs";
import { liveInitialState } from "./live.mjs";
import { liveProps } from "./live-sign.mjs";

const CONTENT_TYPE = {
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  css: "text/css; charset=utf-8",
  // アセット（import 経由でハッシュ付き出力される）
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  pdf: "application/pdf",
};

/// 本番アプリを組み立てる。`clientDir`（dist/client）と `serverDir`（dist/server）を渡す。
/// 返り値の `handle(req, res)` は node:http 互換ハンドラ（Bun/Deno の node 互換でも動く）。
export async function createApp({ clientDir, serverDir, loadDotenv = true } = {}) {
  if (!clientDir || !serverDir) {
    throw new Error("createApp には clientDir と serverDir が必要です");
  }
  if (loadDotenv) loadEnv();

  const manifest = JSON.parse(await readFile(path.join(clientDir, "manifest.json"), "utf8"));

  const registry = new Map();
  for (const [name, file] of Object.entries(manifest.islands ?? {})) {
    const mod = await import(
      pathToFileURL(path.join(serverDir, "islands", `${name}.js`)).href
    );
    if (typeof mod.default === "function") {
      registry.set(mod.default, { name, src: `/_nowaki/${file}` });
    }
  }

  // ライブ島はクライアントへ JS を送らない（live.js が <nowaki-live> を WS で更新する）。
  const liveRegistry = new Map();
  let liveCounter = 0;
  for (const name of manifest.liveIslands ?? []) {
    const mod = await import(
      pathToFileURL(path.join(serverDir, "islands", `${name}.js`)).href
    );
    if (typeof mod.default === "function") {
      liveRegistry.set(mod.default, { name, mod, live: mod.live });
    }
  }

  const prevVnode = options.vnode;
  options.vnode = (vnode) => {
    if (
      typeof vnode.type === "function" &&
      !vnode.props.__nowakiInner &&
      !vnode.props.__nowakiLiveInner
    ) {
      const Original = vnode.type;
      if (liveRegistry.has(vnode.type)) {
        const info = liveRegistry.get(vnode.type);
        vnode.type = (props) => {
          const { state: propState, ...rest } = props;
          const state = propState ?? liveInitialState(info.mod, rest);
          const nid = `L${liveCounter++}`;
          // 署名漏れで verify が必ず失敗しないよう、render.mjs と同じ署名ヘルパーを使う。
          return h(
            "nowaki-live",
            liveProps(info.name, nid, state),
            h(Original, { state, __nowakiLiveInner: true }),
          );
        };
      } else if (registry.has(vnode.type)) {
        const island = registry.get(vnode.type);
        vnode.type = (props) => wrapIsland(island, props, Original);
      }
    }
    if (prevVnode) prevVnode(vnode);
  };

  const routeTable = await scanRoutes(serverDir);

  // サーバー関数の allowlist（build が生成する functions.json）。無ければ機能オフ。
  let serverFnTable = {};
  try {
    serverFnTable = JSON.parse(await readFile(path.join(serverDir, "functions.json"), "utf8"));
  } catch {}
  const serverFunctions = Object.keys(serverFnTable).length
    ? {
        lookup: (id) => serverFnTable[id] ?? null,
        importModule: (m) => import(pathToFileURL(path.join(serverDir, m)).href),
      }
    : null;

  const env = {
    dev: false,
    routeTable: () => routeTable,
    importModule: (file) => import(pathToFileURL(file).href),
    ensureIslands: () => {},
    serverFunctions,
    renderDocument: (args) => prodDocument(manifest, args),
    renderShell: ({ mod, meta }) => prodShell(manifest, mod, meta),
    renderError: (err) => {
      console.error("[nowaki]", err);
      return {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: String(err?.stack ?? err),
      };
    },
  };

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname.startsWith("/_nowaki/")) {
        const name = path.basename(url.pathname); // basename化でtraversal防止
        try {
          const data = await readFile(path.join(clientDir, name));
          const ext = name.split(".").pop();
          res.writeHead(200, {
            "content-type": CONTENT_TYPE[ext] ?? "application/octet-stream",
            "cache-control": "public, max-age=31536000, immutable",
          });
          res.end(data);
        } catch {
          res.writeHead(404).end("not found");
        }
        return;
      }

      const result = await handleRequest(env, {
        method: req.method,
        url,
        version: "prod",
        req,
      });
      await sendResult(res, result);
    } catch (err) {
      console.error("[nowaki]", err);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(err?.stack ?? err));
    }
  };

  return { handle, env, manifest, liveRegistry };
}

/// node:http でリッスンする。アダプタ/`nowaki start` の共通ランチャ。
/// 配備物（dist/server/index.mjs）は host=0.0.0.0 でコンテナから到達可能にする。
export async function startServer({
  clientDir,
  serverDir,
  port = Number(process.env.PORT ?? 3000),
  host = process.env.NOWAKI_HOST ?? "0.0.0.0",
} = {}) {
  const app = await createApp({ clientDir, serverDir });
  const server = createServer(app.handle);
  await new Promise((resolve) => {
    server.listen(port, host, () => {
      // PORT=0 のときは実際に割り当てられたポートを報告する（prerender 等が利用）
      const actual = server.address().port;
      console.log(`NOWAKI_START_READY ${actual}`);
      console.log(`[nowaki] 本番配信: http://${host}:${actual}`);
      resolve();
    });
  });
  return { server, app };
}
