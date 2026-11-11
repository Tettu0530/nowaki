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
// env.ts, compiled by the build; the worker validates it before its first request.
const hasEnv = await readFile(path.join(serverDir, "env.js")).then(() => true, () => false);
// session.ts, compiled by the build.
const hasSession = await readFile(path.join(serverDir, "session.js")).then(() => true, () => false);
const envPublicJson = hasEnv ? await readFile(path.join(serverDir, "env-public.json"), "utf8").catch(() => null) : null;
// nowaki.config routing, inlined; without it the worker imports and checks nothing for it.
const routingJson = await readFile(path.join(serverDir, "routing.json"), "utf8").catch(() => null);
const routingConfig = routingJson ? JSON.parse(routingJson) : null;
const trailingSlash = routingConfig?.trailingSlash;
// basePath: client files and public/ go under it in the assets directory, so the platform serves
// them at the URL the pages use.
const basePath = routingConfig?.basePath ?? "";
// i18n reaches the handler through the routing config (it adds no front rule).
const i18nRouting = routingConfig?.i18n ? routingJson.trim() : null;

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
    ...(m.group ? { group: true } : {}),
  })),
  loadingBoundaries: table.loadingBoundaries.map((b) => ({
    prefix: b.prefix,
    urlPrefix: b.urlPrefix,
    file: (addModule(b.file), keyOf(b.file)),
  })),
  errorBoundaries: table.errorBoundaries.map((b) => ({
    prefix: b.prefix,
    urlPrefix: b.urlPrefix,
    file: (addModule(b.file), keyOf(b.file)),
  })),
  // Parallel-route slots. Intercepting files without a target are listed, not imported.
  slots: table.slots.map((s) => ({
    ownerDir: s.ownerDir,
    name: s.name,
    routes: s.routes.map((r) => ({
      file: (addModule(r.file), keyOf(r.file)),
      segments: r.segments,
      specificity: r.specificity,
      rest: r.rest,
    })),
    default: s.default ? (addModule(s.default), keyOf(s.default)) : null,
    intercepts: s.intercepts.map((i) =>
      i.segments
        ? { file: (addModule(i.file), keyOf(i.file)), rel: i.rel, pattern: i.pattern, segments: i.segments, specificity: i.specificity, rest: i.rest }
        : { file: keyOf(i.file), rel: i.rel },
    ),
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
${contentRaw ? `import * as contentConfig from ${JSON.stringify(specOf("content/config.js"))};\n` : ""}${hasEnv ? `import * as envModule from ${JSON.stringify(specOf("env.js"))};\n` : ""}${hasSession ? `import * as sessionModule from ${JSON.stringify(specOf("session.js"))};\n` : ""}
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
  serverFunctions,${site ? `\n  site: ${JSON.stringify(site)},` : ""}${trailingSlash ? `\n  trailingSlash: ${JSON.stringify(trailingSlash)},` : ""}${fontsJson ? `\n  fonts: ${fontsJson.trim()},` : ""}${contentRaw ? "\n  content," : ""}${hasEnv ? "\n  envModule," : ""}${hasSession ? "\n  sessionModule," : ""}${envPublicJson ? `\n  envPublic: ${envPublicJson.trim()},` : ""}${basePath ? `\n  basePath: ${JSON.stringify(basePath)},` : ""}${hasLive ? "\n  live: { render: liveRender, props: liveProps, initial: liveInitialState, view: liveView }," : ""}${i18nRouting ? `\n  routing: ${i18nRouting},` : ""}
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

${routingJson ? routedFetch(routingJson.trim()) : plainFetch()}`;

/// The worker's fetch without a routing config.
function plainFetch() {
  return `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Static files go to the Assets binding (dist/worker/assets: dist/client under _nowaki/, and
    // public/ at the top).
    if (env.ASSETS && (url.pathname.startsWith("/_nowaki/") || ((request.method === "GET" || request.method === "HEAD") && isPublic(url.pathname)))) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }
    return handler(request, env, undefined, ctx);
  },
};
`;
}

/// The worker's fetch with nowaki.config routing: basePath, trailingSlash, redirects, rewrites and
/// locale detection (i18n.detect) run first (before the Assets binding), and the config headers go
/// on every response.
function routedFetch(routing) {
  return `import { compileRules } from "@nowaki-dev/runtime/server/rules.mjs";
import { frontHeaders, frontLocale, frontStep, withHeaderDefaults, withVary } from "@nowaki-dev/runtime/server/front.mjs";
const rules = compileRules(${routing});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headers = rules ? frontHeaders(rules, url.pathname) : [];
    const step = rules && frontStep(rules, request.method, url);
    if (step?.redirect) {
      const r = new Response(null, { status: step.redirect.status, headers: { location: step.redirect.location } });
      return withSecurityHeaders(withHeaderDefaults(r, headers));
    }
    if (step?.notFound) {
      const r = new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      return withSecurityHeaders(withHeaderDefaults(r, headers));
    }
    // i18n.detect: Accept-Language / the nowaki_locale cookie on the root; the response varies on them.
    const locale = rules?.detect ? frontLocale(rules, request.method, url, request.headers.get("accept-language"), request.headers.get("cookie")) : null;
    if (locale?.redirect) {
      const r = new Response(null, { status: locale.redirect.status, headers: { ...locale.headers, location: locale.redirect.location } });
      return withSecurityHeaders(withHeaderDefaults(r, headers));
    }
    const response = await serve(request, env, url, step, headers, ctx);
    return locale ? withVary(response) : response;
  },
};

async function serve(request, env, url, step, headers, ctx) {
  const routePath = step ? step.routePath : url.pathname;
  // Static files go to the Assets binding (dist/worker/assets: dist/client under
  // <basePath>/_nowaki/, and public/ under basePath), looked up by the route path.
  if (env.ASSETS && (routePath.startsWith("/_nowaki/") || ((request.method === "GET" || request.method === "HEAD") && isPublic(routePath)))) {
    const assetPath = (rules?.base ?? "") + routePath;
    const asset = assetPath === url.pathname ? request : new Request(new URL(assetPath + url.search, url), request);
    return withSecurityHeaders(withHeaderDefaults(await env.ASSETS.fetch(asset), headers));
  }
  // A /__nowaki/* endpoint under basePath: the handler dispatches it by the root URL.
  if (step?.internal) return handler(new Request(new URL(routePath + url.search, url), request), env, { headers }, ctx);
  return handler(request, env, { routePath: step ? routePath : undefined, headers }, ctx);
}
`;
}

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
// The Assets binding serves one directory: dist/client under _nowaki/, public/ files at the top
// (both under basePath when there is one).
const assetsDir = path.join(workerDir, "assets", ...basePath.split("/").filter(Boolean));
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
