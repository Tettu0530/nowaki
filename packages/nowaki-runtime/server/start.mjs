// Entry for `nowaki start` (cwd = app root).
// Local `nowaki start` binds to 127.0.0.1 (only the deploy entry uses 0.0.0.0).

import path from "node:path";
import { startServer } from "./app.mjs";

const appRoot = process.cwd();
await startServer({
  clientDir: path.join(appRoot, "dist/client"),
  serverDir: path.join(appRoot, "dist/server"),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.NOWAKI_HOST ?? "127.0.0.1",
});
