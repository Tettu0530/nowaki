// Build-time generator for the Cloudflare Workers adapter (runs on Node). Workers disallow runtime
// file imports, so this emits a worker entry that statically imports every server module.
//
// Usage: node edge-build.mjs <serverDir> <clientDir> <workerDir> [appName]

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { scanRoutes } from "./router.mjs";

const [serverDir, clientDir, workerDir, appNameArg] = process.argv.slice(2);
if (!serverDir || !clientDir || !workerDir) {
  console.error("usage: edge-build.mjs <serverDir> <clientDir> <workerDir> [appName]");
  process.exit(1);
}
const appName = appNameArg || "nowaki-app";

const manifest = JSON.parse(await readFile(path.join(clientDir, "manifest.json"), "utf8"));
const table = await scanRoutes(serverDir);

const keyOf = (abs) => path.relative(serverDir, abs).split(path.sep).join("/");
// specifiers relative to dist/worker/index.js
const specOf = (key) => `../server/${key}`;

const order = [];
const seen = new Map(); // key -> varName
const addModule = (abs) => {
  const key = keyOf(abs);
  if (!seen.has(key)) {
    const varName = `m${seen.size}`;
    seen.set(key, varName);
    order.push(key);
  }
  return seen.get(key);
};

const routeTable = {
  routes: table.routes.map((r) => ({
    file: (addModule(r.file), keyOf(r.file)),
    segments: r.segments,
    isApi: r.isApi,
    specificity: r.specificity,
  })),
  layouts: table.layouts.map((l) => ({ prefix: l.prefix, file: (addModule(l.file), keyOf(l.file)) })),
  middleware: table.middleware.map((m) => ({
    prefix: m.prefix,
    file: (addModule(m.file), keyOf(m.file)),
  })),
  notFound: table.notFound ? (addModule(table.notFound), keyOf(table.notFound)) : null,
  errorRoute: table.errorRoute ? (addModule(table.errorRoute), keyOf(table.errorRoute)) : null,
};

const islandImports = [];
const islandEntries = [];
let islIdx = 0;
for (const name of Object.keys(manifest.islands ?? {})) {
  const abs = path.join(serverDir, "islands", `${name}.js`);
  const v = `isl${islIdx++}`;
  islandImports.push(`import * as ${v} from ${JSON.stringify(specOf(`islands/${name}.js`))};`);
  islandEntries.push(`  ${JSON.stringify(name)}: ${v}.default,`);
}

const liveImports = [];
const liveEntries = [];
for (const [i, name] of (manifest.liveIslands ?? []).entries()) {
  liveImports.push(`import * as live${i} from ${JSON.stringify(specOf(`islands/${name}.js`))};`);
  liveEntries.push(`  ${JSON.stringify(name)}: live${i},`);
}

let serverFnTable = {};
try {
  serverFnTable = JSON.parse(await readFile(path.join(serverDir, "functions.json"), "utf8"));
} catch {}
for (const entry of Object.values(serverFnTable)) {
  addModule(path.join(serverDir, entry.module));
}

const moduleImports = order.map((key) => `import * as ${seen.get(key)} from ${JSON.stringify(specOf(key))};`);
const moduleEntries = order.map((key) => `  ${JSON.stringify(key)}: ${seen.get(key)},`);

const worker = `// Generated: worker entry for the Cloudflare Workers (Edge) adapter.
// Statically imports every server module and passes them to the @nowaki-dev/runtime web handler.
import { createFetchHandler } from "@nowaki-dev/runtime/server/web.mjs";
${moduleImports.join("\n")}
${islandImports.join("\n")}
${liveImports.join("\n")}

const manifest = ${JSON.stringify(manifest)};
const modules = {
${moduleEntries.join("\n")}
};
const islandComponents = {
${islandEntries.join("\n")}
};
const liveIslands = {
${liveEntries.join("\n")}
};
const routeTable = ${JSON.stringify(routeTable)};
const serverFunctions = ${JSON.stringify(serverFnTable)};

const handler = createFetchHandler({
  manifest,
  modules,
  islandComponents,
  liveIslands,
  routeTable,
  serverFunctions,
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Static assets go to the Assets binding (dist/client), fetched with /_nowaki/<f> rewritten to /<f>.
    if (url.pathname.startsWith("/_nowaki/") && env.ASSETS) {
      const assetUrl = new URL(url);
      assetUrl.pathname = url.pathname.slice("/_nowaki".length);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    return handler(request);
  },
};
`;

const wrangler = `{
  "name": ${JSON.stringify(appName)},
  "main": "index.js",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "../client",
    "binding": "ASSETS",
    "html_handling": "none",
    "not_found_handling": "none"
  }
}
`;

// Empty it rather than delete it: Windows can't remove a directory in use as a working directory.
for (const name of await readdir(workerDir).catch(() => [])) {
  await rm(path.join(workerDir, name), { recursive: true, force: true });
}
await mkdir(workerDir, { recursive: true });
await writeFile(path.join(workerDir, "index.js"), worker);
await writeFile(path.join(workerDir, "wrangler.jsonc"), wrangler);
console.log(
  `[nowaki] cloudflare adapter: ${order.length} server modules + ${islIdx} islands → ${path.join(workerDir, "index.js")}`,
);
