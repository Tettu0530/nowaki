// Vercel アダプタのビルド時生成器（Node 実行）。Build Output API v3 を `.vercel/output/` に出力する。
// Function は自己完結が前提なので、dist/server と必要な node_modules を Function へ取り込む。
//
// 使い方: node vercel-build.mjs <serverDir> <clientDir> <outputDir> <appRoot>

import { writeFile, mkdir, cp, rm } from "node:fs/promises";
import path from "node:path";

const [serverDir, clientDir, outputDir, appRoot] = process.argv.slice(2);
if (!serverDir || !clientDir || !outputDir || !appRoot) {
  console.error("usage: vercel-build.mjs <serverDir> <clientDir> <outputDir> <appRoot>");
  process.exit(1);
}

const funcDir = path.join(outputDir, "functions", "index.func");
const staticDir = path.join(outputDir, "static");

await rm(outputDir, { recursive: true, force: true });
await mkdir(funcDir, { recursive: true });
await mkdir(staticDir, { recursive: true });

// dist/client/* → static/_nowaki/*（Vercel が配信）
await cp(clientDir, path.join(staticDir, "_nowaki"), { recursive: true });

await cp(serverDir, path.join(funcDir, "server"), { recursive: true });
await mkdir(path.join(funcDir, "client"), { recursive: true });
await cp(path.join(clientDir, "manifest.json"), path.join(funcDir, "client", "manifest.json"));

const nodeModules = path.join(funcDir, "node_modules");
for (const dep of ["@nowaki-dev/runtime", "preact", "preact-render-to-string"]) {
  const src = path.join(appRoot, "node_modules", dep);
  // 依存パッケージの「ネストした node_modules」は取り込まない。取り込むと preact が
  // 二重になり（runtime の devDep）、フックが別インスタンスになって SSR が正しく動かなくなる。
  // Node は上位 node_modules を辿るので、トップレベルの単一 preact に解決される。
  await cp(src, path.join(nodeModules, dep), {
    recursive: true,
    dereference: true,
    filter: (s) => !path.relative(src, s).split(path.sep).includes("node_modules"),
  });
}

const handler = `// 自動生成: Vercel serverless function（Node）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "@nowaki-dev/runtime/server/app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle } = await createApp({
  clientDir: path.join(here, "client"),
  serverDir: path.join(here, "server"),
});
export default handle;
`;
await writeFile(path.join(funcDir, "index.mjs"), handler);

// launcher=Nodejs で (req,res) ハンドラを受ける。
await writeFile(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs20.x", handler: "index.mjs", launcherType: "Nodejs" }, null, 2) +
    "\n",
);

const config = {
  version: 3,
  routes: [
    {
      src: "/_nowaki/(.*)",
      headers: { "cache-control": "public, max-age=31536000, immutable" },
      continue: true,
    },
    { handle: "filesystem" },
    { src: "/.*", dest: "/index" },
  ],
};
await writeFile(path.join(outputDir, "config.json"), JSON.stringify(config, null, 2) + "\n");

console.log(`[nowaki] vercel adapter: .vercel/output ready (static + index.func) → ${outputDir}`);
