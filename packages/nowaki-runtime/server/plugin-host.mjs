// Plugin host. Spawned by Rust (dev/build); serves nowaki.config plugin hooks
// over HTTP. Signals readiness with "NOWAKI_PLUGIN_HOST_READY <port>" on stdout.
//
// nowaki.config.mjs (or .js):
//   export default {
//     plugins: [
//       { name: "my-plugin", transform(code, id) { return code.replaceAll("__X__", "1"); } },
//     ],
//   };

import "./exit-with-parent.mjs";
import { Console } from "node:console";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { configOf, normalizeConfig } from "./site-config.mjs";

const appRoot = process.cwd();

// stdout carries the READY handshake to Rust; everything a plugin prints goes to stderr so it
// can't be mistaken for protocol output. Rust keeps draining stdout anyway (a plugin may call
// process.stdout.write directly), and a write error there must not kill the host.
const writeStdout = process.stdout.write.bind(process.stdout);
const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
for (const key of Object.keys(stderrConsole)) {
  if (typeof stderrConsole[key] === "function") console[key] = stderrConsole[key].bind(stderrConsole);
}
process.stdout.on("error", () => {});

async function loadConfig() {
  for (const name of ["nowaki.config.mjs", "nowaki.config.js"]) {
    const p = path.join(appRoot, name);
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      try {
        return { name, config: configOf(mod) };
      } catch (error) {
        return { name, config: {}, error };
      }
    }
  }
  return { name: null, config: {} };
}

const { name: configName, config, error: configError } = await loadConfig();

// NOWAKI_SITE_CONFIG=1: the CLI also wants site-config.mjs's normalized config (site, fonts,
// routing, images), answered in /caps. Doing it here saves a second Node start and config import.
let siteConfig;
if (process.env.NOWAKI_SITE_CONFIG === "1") {
  try {
    if (configError) throw configError;
    siteConfig = { ok: configName ? await normalizeConfig(config) : {} };
  } catch (e) {
    siteConfig = { error: `${configName}: ${e?.message ?? e}` };
  }
} else if (configError) {
  console.error(`[nowaki] ${configName}: ${configError.message}`);
}
const plugins = (config.plugins ?? []).filter((p) => p && typeof p === "object");
const transformers = plugins.filter((p) => typeof p.transform === "function");
const resolvers = plugins.filter((p) => typeof p.resolveId === "function");
const loaders = plugins.filter((p) => typeof p.load === "function");

// If the app has @tsrx/preact, compile .tsrx to JSX. This host lives under the runtime
// package, so resolve relative to the app's node_modules.
let tsrxCompile = null;
try {
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const resolved = appRequire.resolve("@tsrx/preact");
  const mod = await import(pathToFileURL(resolved).href);
  if (typeof mod.compile === "function") tsrxCompile = mod.compile;
} catch {}

// Pipes each stage's output to the next. null if nobody changed it.
async function runTransform(id, code) {
  let current = code;
  let changed = false;
  for (const p of transformers) {
    const out = await p.transform(current, id);
    if (out == null) continue;
    const next = typeof out === "string" ? out : out.code;
    if (typeof next === "string" && next !== current) {
      current = next;
      changed = true;
    }
  }
  return changed ? current : null;
}

// The first plugin to return an id wins.
async function runResolveId(source, importer) {
  for (const p of resolvers) {
    const out = await p.resolveId(source, importer);
    if (out == null) continue;
    const id = typeof out === "string" ? out : out.id;
    if (typeof id === "string") return id;
  }
  return null;
}

// The first plugin to return source wins.
async function runLoad(id) {
  for (const p of loaders) {
    const out = await p.load(id);
    if (out == null) continue;
    const code = typeof out === "string" ? out : out.code;
    if (typeof code === "string") return code;
  }
  return null;
}

// Set Content-Length explicitly so the simple Rust HTTP client needn't handle chunked.
function sendJson(res, status, obj) {
  const json = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/caps") {
      sendJson(res, 200, {
        hasTransform: transformers.length > 0,
        hasTsrx: !!tsrxCompile,
        hasResolveId: resolvers.length > 0,
        hasLoad: loaders.length > 0,
        siteConfig,
      });
      return;
    }
    if (url.pathname === "/resolveId" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { source, importer } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      sendJson(res, 200, { id: await runResolveId(source, importer) });
      return;
    }
    if (url.pathname === "/load" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { id } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      sendJson(res, 200, { code: await runLoad(id) });
      return;
    }
    if (url.pathname === "/transform" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { id, code } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const out = await runTransform(id, code);
      sendJson(res, 200, { code: out });
      return;
    }
    if (url.pathname === "/tsrx" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { id, code } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let out = null;
      if (tsrxCompile) {
        const r = tsrxCompile(code, { filename: id });
        if (r?.errors?.length) {
          sendJson(res, 200, { code: null, error: JSON.stringify(r.errors) });
          return;
        }
        out = r?.code ?? null;
      }
      sendJson(res, 200, { code: out });
      return;
    }
    res.writeHead(404).end();
  } catch (err) {
    sendJson(res, 500, { error: String(err?.stack ?? err) });
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  writeStdout(`NOWAKI_PLUGIN_HOST_READY ${port}\n`);
  console.error(
    `[nowaki] plugin host: ${plugins.length} plugin(s), ${transformers.length} transform, ${resolvers.length} resolveId, ${loaders.length} load, tsrx=${!!tsrxCompile}`,
  );
});
