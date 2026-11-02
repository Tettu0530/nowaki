// dev SSR サイドカー。Rust dev サーバーから起動され、ページ描画と API ルートを担当する。
// 起動完了は stdout の "NOWAKI_SIDECAR_READY <port>" で Rust へ通知する。

import { createServer } from "node:http";
import { register } from "node:module";
import path from "node:path";
import { loadEnv } from "./env.mjs";

// ルート/loader が process.env を読めるよう、ルート読込より前に .env を読む
loadEnv();

// 以降のdynamic importする .tsx/.ts はRustの変換エンドポイント経由で読み込まれる
register(new URL("./loader-hooks.mjs", import.meta.url));

const { scanRoutes } = await import("./router.mjs");
const { loadIslandRegistry, renderDocument, renderShell, errorPage } = await import("./render.mjs");
const { handleRequest, sendResult } = await import("./handler.mjs");
const { liveRender } = await import("./live.mjs");
const { pathToFileURL } = await import("node:url");

const appRoot = process.cwd();
const RUST = `http://127.0.0.1:${process.env.NOWAKI_RUST_PORT ?? "3000"}`;

// dev は build しないのでサーバー関数の allowlist は Rust が discover する。HMR 世代ごとにキャッシュ。
const fnCache = new Map();
async function serverFnEntries(version) {
  if (fnCache.has(version)) return fnCache.get(version);
  let entries = {};
  try {
    const r = await fetch(`${RUST}/__nowaki/server-functions?v=${encodeURIComponent(version)}`);
    if (r.ok) entries = (await r.json()).entries ?? {};
  } catch {}
  fnCache.set(version, entries);
  return entries;
}

const env = {
  dev: true,
  // dev は毎リクエスト再スキャン（ファイル変更を反映）
  routeTable: () => scanRoutes(appRoot),
  importModule: (file, version) => import(`${pathToFileURL(file).href}?v=${version}`),
  ensureIslands: (version) => loadIslandRegistry(appRoot, version),
  serverFunctions: {
    async lookup(id, version) {
      const entries = await serverFnEntries(String(version ?? "0"));
      return entries[id] ?? null;
    },
    // dev は dist が無いのでソースを直接 import（loader-hooks が Rust 変換へ橋渡し）。
    importModule: (m, version) =>
      import(`${pathToFileURL(path.join(appRoot, m)).href}?v=${version}`),
  },
  renderDocument,
  renderShell,
  renderError: (err) => {
    console.error("[nowaki ssr]", err);
    return {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: errorPage(String(err?.stack ?? err)),
    };
  },
};

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url.startsWith("/__nowaki/live-render")) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { name, state, handler, payload, version, sig } = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      const reg = await loadIslandRegistry(appRoot, String(version ?? "0"));
      const entry = [...reg.values()].find((e) => e.name === name);
      if (!entry?.live) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "live island not found" }));
        return;
      }
      const result = await liveRender(entry.mod, state, handler, payload, name, sig);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error("[nowaki live]", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.stack ?? err) }));
    }
    return;
  }
  try {
    const version = String(req.headers["x-nowaki-ssr-version"] ?? "0");
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const result = await handleRequest(env, {
      method: req.method,
      url,
      version,
      req,
    });
    await sendResult(res, result);
  } catch (err) {
    console.error("[nowaki ssr]", err);
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(errorPage(String(err?.stack ?? err)));
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(`NOWAKI_SIDECAR_READY ${server.address().port}`);
});
