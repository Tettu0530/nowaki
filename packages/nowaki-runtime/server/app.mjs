// Core of the production app, shared by `nowaki start` and each adapter's self-contained entry.
// clientDir / serverDir are passed in, so it's tied to neither cwd nor import.meta's location.

import { createServer } from "node:http";
import { register } from "node:module";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { h, options } from "preact";
import { loadEnv } from "./env.mjs";
import { wrapIsland } from "./island-directive.mjs";
import { scanRoutes } from "./router.mjs";
import { handleRequest, sendResult } from "./handler.mjs";
import { missingSecurityHeaders } from "./security-headers.mjs";
import { applyCsp } from "./csp.mjs";
import { prodDocument, prodShell } from "./document.mjs";
import { liveInitialState, liveRender, liveTopics, liveView } from "./live.mjs";
import { loadContent } from "./content-load.mjs";
import { initServerEnv } from "./env-schema.mjs";
import { liveProps, warnIfEphemeralLiveKey } from "./live-sign.mjs";
import { indexPublic, lookupPublic } from "./public-files.mjs";
import { resolveSite } from "./seo.mjs";
import { requestOrigin } from "./origin.mjs";
import { compileRules } from "./rules.mjs";
import { frontHeaders, frontStep } from "./front.mjs";

// Route modules are imported later, so libraries in them resolve React through this hook.
// Bun and Deno don't implement Node's module.register; their SSR keeps the old behavior.
try {
  register(new URL("./react-alias-hooks.mjs", import.meta.url));
} catch {}

const CONTENT_TYPE = {
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  css: "text/css; charset=utf-8",
  // assets (emitted with hashes via import)
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
  // public/ files (not hashed, served as-is)
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  webmanifest: "application/manifest+json",
  wasm: "application/wasm",
  zip: "application/zip",
};

const contentTypeOf = (name) => {
  const base = name.split("/").pop();
  const dot = base.lastIndexOf(".");
  return (dot > 0 && CONTENT_TYPE[base.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
};

/// Builds the production app. Pass `clientDir` (dist/client) and `serverDir` (dist/server).
/// The returned `handle(req, res)` is a node:http-compatible handler (also works under Bun/Deno node compat).
export async function createApp({ clientDir, serverDir, publicDir, loadDotenv = true } = {}) {
  if (!clientDir || !serverDir) {
    throw new Error("createApp requires clientDir and serverDir");
  }
  if (loadDotenv) loadEnv();
  // env.ts, validated before any app module loads (one may read env at its top level). Invalid →
  // createApp throws, so the server never listens.
  const envFile = path.join(serverDir, "env.js");
  const envModule = await access(envFile).then(() => import(pathToFileURL(envFile).href), () => null);
  const envPublic = envModule
    ? await readFile(path.join(serverDir, "env-public.json"), "utf8").then(JSON.parse, () => undefined)
    : undefined;
  await initServerEnv(envModule, process.env, envPublic);

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

  // Live islands send no JS to the client (live.js updates <nowaki-live> over WS or POST).
  const liveRegistry = new Map();
  const liveByName = new Map();
  let liveCounter = 0;
  if ((manifest.liveIslands ?? []).length > 0) warnIfEphemeralLiveKey();
  for (const name of manifest.liveIslands ?? []) {
    const mod = await import(
      pathToFileURL(path.join(serverDir, "islands", `${name}.js`)).href
    );
    if (typeof mod.default === "function") {
      liveRegistry.set(mod.default, { name, mod, live: mod.live });
      liveByName.set(name, mod);
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
          // Use the same signing helper as render.mjs so verify can't always fail on a missing signature.
          return h(
            "nowaki-live",
            liveProps(info.name, nid, state, liveTopics(info.mod, state)),
            h(Original, { state: liveView(info.mod, state), __nowakiLiveInner: true }),
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
  // Content collections: validated once at startup; an invalid entry stops the server.
  const content = await loadContent(serverDir);
  if (content?.errors.length) throw new Error(`[nowaki] content collections:\n  ${content.errors.join("\n  ")}`);

  // Server function allowlist (functions.json generated by build). Feature is off without it.
  let serverFnTable = {};
  try {
    serverFnTable = JSON.parse(await readFile(path.join(serverDir, "functions.json"), "utf8"));
  } catch {}
  // Production modules never change, so each is imported once. A bare `import()` per request is
  // not free: with the react-alias loader hooks registered, every call does a synchronous round
  // trip to the hooks thread to resolve the specifier, which was half the CPU time of a page.
  const modules = new Map();
  const importOnce = (href) => {
    let p = modules.get(href);
    if (!p) {
      p = import(href);
      modules.set(href, p);
      p.catch(() => modules.delete(href));
    }
    return p;
  };
  const byPath = new Map();
  // The manifest and the modules don't change in production, so per-file lookups are computed once.
  const scriptsByFile = new Map();
  const cssByFile = new Map();
  const memo = (cache, key, make) => {
    let v = cache.get(key);
    if (v === undefined) cache.set(key, (v = make()));
    return v;
  };
  const moduleKey = (file) => path.relative(serverDir, file).split(path.sep).join("/");
  const serverFunctions = Object.keys(serverFnTable).length
    ? {
        lookup: (id) => serverFnTable[id] ?? null,
        importModule: (m) => importOnce(pathToFileURL(path.join(serverDir, m)).href),
      }
    : null;

  // NOWAKI_SITE, else nowaki.config `site` (the build writes it to dist/server/site.json).
  const builtSite = await readFile(path.join(serverDir, "site.json"), "utf8")
    .then((t) => JSON.parse(t).site)
    .catch(() => undefined);
  // Self-hosted fonts, from the build (dist/server/fonts.json).
  const fonts = await readFile(path.join(serverDir, "fonts.json"), "utf8")
    .then((t) => JSON.parse(t))
    .catch(() => null);
  const env = {
    dev: false,
    // Prerendering for static output: pages are files (`x/index.html`), so their URLs end in `/`.
    staticOutput: process.env.NOWAKI_PRERENDER === "1",
    site: resolveSite(builtSite),
    fonts,
    routeTable: () => routeTable,
    // Keyed by the path, so the URL conversion runs once per module, not on every call (a page
    // imports its layouts several times per request).
    importModule: (file) => {
      let p = byPath.get(file);
      if (!p) {
        p = importOnce(pathToFileURL(file).href);
        byPath.set(file, p);
        p.catch(() => byPath.delete(file));
      }
      return p;
    },
    ensureIslands: () => {},
    serverFunctions,
    live: liveByName.size
      ? { lookup: (name) => liveByName.get(name) ?? null, render: liveRender }
      : null,
    // `nowaki prerender` sets NOWAKI_PRERENDER=1 on its temporary server: the pages become static
    // files, so live islands get no live.js (it could never reach a server).
    renderDocument: (args) => prodDocument(manifest, args, { live: process.env.NOWAKI_PRERENDER !== "1" }),
    renderShell: ({ mod, meta }) => prodShell(manifest, mod, meta),
    // Page scripts from the build (manifest.routeScripts per route / layout module).
    routeScripts: (file) =>
      memo(scriptsByFile, file, () =>
        (manifest.routeScripts?.[moduleKey(file)] ?? []).map((f) => ({
          src: `/_nowaki/${f}`,
          preload: (manifest.scriptPreload?.[f] ?? []).map((d) => `/_nowaki/${d}`),
        })),
      ),
    // Route / layout CSS from the build (manifest.routeCss, keyed by server module).
    routeCss: (file) => memo(cssByFile, file, () => (manifest.routeCss?.[moduleKey(file)] ?? []).map((f) => `/_nowaki/${f}`)),
    // render500 has already logged it.
    renderError: () => {
      return {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
        // Production: never send the stack (it leaks file paths and code); it's logged above.
        body: "Internal Server Error",
      };
    },
  };

  // dist/public next to dist/client unless given.
  const publicFiles = await indexPublic(publicDir ?? path.join(clientDir, "..", "public"));
  // nowaki.config routing (dist/server/routing.json, written only when there is one): null
  // without it, so a request pays one check. An invalid file stops the server here.
  const rules = await readFile(path.join(serverDir, "routing.json"), "utf8").then(
    (t) => compileRules(JSON.parse(t)),
    (e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    },
  );

  const handle = async (req, res) => {
    // Set before the response's own headers, which override any of these by name.
    for (const [k, v] of missingSecurityHeaders(() => false)) res.setHeader(k, v);
    try {
      const url = new URL(req.url, requestOrigin((name) => req.headers[name]));
      let pathname = url.pathname;
      let routePath;
      if (rules) {
        // Config headers replace the security defaults set above and lose to the response's own.
        for (const [k, v] of frontHeaders(rules, pathname)) res.setHeader(k, v);
        const step = frontStep(rules, req.method, url);
        if (step?.redirect) {
          res.writeHead(step.redirect.status, { location: step.redirect.location }).end();
          return;
        }
        if (step?.notFound) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
          return;
        }
        if (step) pathname = routePath = step.routePath;
      }

      if (pathname.startsWith("/_nowaki/")) {
        const name = path.basename(pathname); // basename prevents traversal
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

      // public/ files win over routes at the same path. `no-cache` + ETag: the names aren't hashed.
      const pub = (req.method === "GET" || req.method === "HEAD") && lookupPublic(publicFiles, pathname);
      if (pub) {
        const headers = { "content-type": contentTypeOf(pathname), "cache-control": "public, no-cache", etag: pub.etag };
        const inm = req.headers["if-none-match"];
        if (inm && inm.split(",").some((t) => t.trim() === pub.etag || t.trim() === "*")) {
          res.writeHead(304, headers).end();
          return;
        }
        try {
          const data = await readFile(pub.file);
          res.writeHead(200, { ...headers, "content-length": data.length });
          res.end(req.method === "HEAD" ? undefined : data);
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
        routePath,
      });
      await sendResult(res, applyCsp(result));
    } catch (err) {
      console.error("[nowaki]", err);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  };

  return { handle, env, manifest, liveRegistry };
}

/// Listens via node:http. Shared launcher for adapters and `nowaki start`.
/// The deployable (dist/server/index.mjs) uses host=0.0.0.0 so it's reachable from containers.
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
      // with PORT=0, report the actually assigned port (used by prerender etc.)
      const actual = server.address().port;
      console.log(`NOWAKI_START_READY ${actual}`);
      console.log(`[nowaki] serving production: http://${host}:${actual}`);
      resolve();
    });
  });
  return { server, app };
}

