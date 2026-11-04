// Build-time generator for the Vercel adapter (runs on Node). Emits Build Output API v3 to `.vercel/output/`.
// Functions must be self-contained, so dist/server and the needed node_modules are copied into the Function.
//
// Usage: node vercel-build.mjs <serverDir> <clientDir> <outputDir> <appRoot>

import { writeFile, mkdir, cp, rm } from "node:fs/promises";
import path from "node:path";
import { missingSecurityHeaders } from "./security-headers.mjs";

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

// dist/client/* → static/_nowaki/* (served by Vercel)
await cp(clientDir, path.join(staticDir, "_nowaki"), { recursive: true });

await cp(serverDir, path.join(funcDir, "server"), { recursive: true });
await mkdir(path.join(funcDir, "client"), { recursive: true });
await cp(path.join(clientDir, "manifest.json"), path.join(funcDir, "client", "manifest.json"));

const nodeModules = path.join(funcDir, "node_modules");
for (const dep of ["@nowaki-dev/runtime", "preact", "preact-render-to-string"]) {
  const src = path.join(appRoot, "node_modules", dep);
  // Don't copy dependencies' nested node_modules. Doing so duplicates preact
  // (runtime's devDep), splitting hooks across instances and breaking SSR.
  // Node walks up node_modules, so it resolves to the single top-level preact.
  await cp(src, path.join(nodeModules, dep), {
    recursive: true,
    dereference: true,
    filter: (s) => !path.relative(src, s).split(path.sep).includes("node_modules"),
  });
}

const handler = `// Generated: Vercel serverless function (Node).
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

// launcher=Nodejs accepts a (req,res) handler.
await writeFile(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs" }, null, 2) +
    "\n",
);

const config = {
  version: 3,
  routes: [
    {
      // Static files skip the function, so they get the default security headers here; pages get
      // them from app.mjs inside the function.
      src: "/_nowaki/(.*)",
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        ...Object.fromEntries(missingSecurityHeaders(() => false)),
      },
      continue: true,
    },
    { handle: "filesystem" },
    { src: "/.*", dest: "/index" },
  ],
};
await writeFile(path.join(outputDir, "config.json"), JSON.stringify(config, null, 2) + "\n");

console.log(`[nowaki] vercel adapter: .vercel/output ready (static + index.func) → ${outputDir}`);
