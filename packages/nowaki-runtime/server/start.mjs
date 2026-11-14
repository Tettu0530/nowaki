// Entry for the Node render servers `nowaki prerender` starts (cwd = app root): app.mjs over
// dist/. `nowaki start` does not use it (it runs prod-sidecar.mjs). Binds 127.0.0.1 unless
// NOWAKI_HOST is set.

import "./exit-with-parent.mjs";
import path from "node:path";
import { startServer } from "./app.mjs";

const appRoot = process.cwd();
await startServer({
  clientDir: path.join(appRoot, "dist/client"),
  serverDir: path.join(appRoot, "dist/server"),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.NOWAKI_HOST ?? "127.0.0.1",
});
