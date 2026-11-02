// `nowaki start` のエントリ（cwd=アプリルート）。
// ローカルの `nowaki start` は 127.0.0.1 に固定（配備用エントリだけ 0.0.0.0）。

import path from "node:path";
import { startServer } from "./app.mjs";

const appRoot = process.cwd();
await startServer({
  clientDir: path.join(appRoot, "dist/client"),
  serverDir: path.join(appRoot, "dist/server"),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.NOWAKI_HOST ?? "127.0.0.1",
});
