// Build-time generator for the Cloudflare Workers adapter (runs on Node). Workers disallow runtime
// file imports, so this emits a worker entry that statically imports every server module.
//
// Usage: node edge-build.mjs <serverDir> <clientDir> <workerDir> [appName]

import { readFile, writeFile, mkdir, readdir, rm, cp } from "node:fs/promises";
import path from "node:path";
import { scanRoutes } from "./router.mjs";
import { indexPublic } from "./public-files.mjs";

const [serverDir, clientDir, workerDir, appNameArg] = process.argv.slice(2);
if (!serverDir || !clientDir || !workerDir) {
  console.error("usage: edge-build.mjs <serverDir> <clientDir> <workerDir> [appName]");
  process.exit(1);
}
const appName = appNameArg || "nowaki-app";

const manifest = JSON.parse(await readFile(path.join(clientDir, "manifest.json"), "utf8"));
// dist/public (nowaki build copies public/ there)
const publicIndex = await indexPublic(path.join(clientDir, "..", "public"));
const publicPaths = [...publicIndex.keys()];
// nowaki.config `site`, written by the build (NOWAKI_SITE as a Worker var still wins at runtime).
const site = await readFile(path.join(serverDir, "site.json"), "utf8").then((t) => JSON.parse(t).site).catch(() => undefined);
const fontsJson = await readFile(path.join(serverDir, "fonts.json"), "utf8").catch(() => null);
// Content collections (written by `nowaki build`), inlined: an edge worker has no file system.
const contentRaw = await readFile(path.join(serverDir, "content/index.json"), "utf8").catch(() => null);
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
    dir: r.dir,
    segments: r.segments,
    isApi: r.isApi,
    fileExt: r.fileExt,
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
// Signing needs node:crypto (nodejs_compat), so only apps with live islands import it.
const hasLive = liveImports.length > 0;
if (hasLive) {
  liveImports.unshift(
    `import { liveInitialState, liveRender, liveView } from "@nowaki-dev/runtime/server/live.mjs";`,
    `import { liveProps } from "@nowaki-dev/runtime/server/live-sign.mjs";`,
  );
}

let serverFnTable = {};
try {
  serverFnTable = JSON.parse(await readFile(path.join(serverDir, "functions.json"), "utf8"));
} catch {}
for (const entry of Object.values(serverFnTable)) {
  addModule(path.join(serverDir, entry.module));
}
// MDX content entries render from their compiled modules (a worker can't import at runtime).
if (contentRaw) {
  for (const entries of Object.values(JSON.parse(contentRaw))) {
    for (const e of entries) if (e.module) addModule(path.join(serverDir, e.module));
  }
}

const moduleImports = order.map((key) => `import * as ${seen.get(key)} from ${JSON.stringify(specOf(key))};`);
const moduleEntries = order.map((key) => `  ${JSON.stringify(key)}: ${seen.get(key)},`);

const worker = `// Generated: worker entry for the Cloudflare Workers (Edge) adapter.
// Statically imports every server module and passes them to the @nowaki-dev/runtime web handler.
import { createFetchHandler } from "@nowaki-dev/runtime/server/web.mjs";
import { withSecurityHeaders } from "@nowaki-dev/runtime/server/security-headers.mjs";
${moduleImports.join("\n")}
${islandImports.join("\n")}
${liveImports.join("\n")}
${contentRaw ? `import * as contentConfig from ${JSON.stringify(specOf("content/config.js"))};\n` : ""}
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
${contentRaw ? `const content = { raw: ${contentRaw}, config: contentConfig };\n` : ""}
const handler = createFetchHandler({
  manifest,
  modules,
  islandComponents,
  liveIslands,
  routeTable,
  serverFunctions,${site ? `\n  site: ${JSON.stringify(site)},` : ""}${fontsJson ? `\n  fonts: ${fontsJson.trim()},` : ""}${contentRaw ? "\n  content," : ""}${hasLive ? "\n  live: { render: liveRender, props: liveProps, initial: liveInitialState, view: liveView }," : ""}
});

// public/ files by decoded URL path; they win over routes at the same path.
const publicFiles = new Set(${JSON.stringify(publicPaths)});
const isPublic = (pathname) => {
  if (publicFiles.size === 0) return false;
  try {
    return publicFiles.has(decodeURIComponent(pathname));
  } catch {
    return false;
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Static files go to the Assets binding (dist/worker/assets: dist/client under _nowaki/, and
    // public/ at the top).
    if (env.ASSETS && (url.pathname.startsWith("/_nowaki/") || ((request.method === "GET" || request.method === "HEAD") && isPublic(url.pathname)))) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }
    return handler(request);
  },
};
`;

// populate_process_env: Worker vars/secrets (NOWAKI_LIVE_SECRET, NOWAKI_CSP, ...) reach process.env,
// where the runtime reads them; without it every isolate signs live state with its own random key.
const wrangler = `{
  "name": ${JSON.stringify(appName)},
  "main": "index.js",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat", "nodejs_compat_populate_process_env"],
  "assets": {
    "directory": "./assets",
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
// The Assets binding serves one directory: dist/client under _nowaki/, public/ files at the top.
const assetsDir = path.join(workerDir, "assets");
await cp(clientDir, path.join(assetsDir, "_nowaki"), { recursive: true });
for (const [url, { file }] of publicIndex) {
  const to = path.join(assetsDir, ...url.split("/").filter(Boolean));
  await mkdir(path.dirname(to), { recursive: true });
  await cp(file, to);
}
await writeFile(path.join(workerDir, "wrangler.jsonc"), wrangler);
console.log(
  `[nowaki] cloudflare adapter: ${order.length} server modules + ${islIdx} islands → ${path.join(workerDir, "index.js")}`,
);
