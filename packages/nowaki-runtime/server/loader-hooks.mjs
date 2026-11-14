// Node module loader hooks for the dev sidecar. Rust stays the only transformer: .ts / .tsx / .jsx /
// .tsrx / .mdx / .mdoc modules are fetched from the Rust dev server's transform endpoint
// (/__nowaki/ssr-module) and returned as ESM (vite-node style).

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUST = `http://127.0.0.1:${process.env.NOWAKI_RUST_PORT ?? "3000"}`;
const TS_RE = /\.(tsx|ts|jsx|tsrx|mdx|mdoc)$/;
// The app's plain ES modules are loaded by Node as they are, but still need the generation, or an
// edit to lib/x.js is never re-evaluated. Only files under the app root and outside node_modules:
// a second copy of preact or of the runtime (a workspace symlink resolves outside the root) would
// split hooks and the request context.
const JS_RE = /\.(js|mjs)$/;
let appRootHref = rootHref(process.cwd());

export function initialize(data) {
  if (data?.root) appRootHref = rootHref(data.root);
}

function rootHref(dir) {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  const href = pathToFileURL(real).href;
  return href.endsWith("/") ? href : href + "/";
}

export function versioned(url) {
  if (TS_RE.test(url.pathname)) return true;
  return JS_RE.test(url.pathname) && url.href.startsWith(appRootHref) && !url.pathname.includes("/node_modules/");
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  // Copy the parent module's ?v= (HMR generation) onto the imports it resolves, so an edit
  // re-evaluates them too.
  if (context.parentURL && result.url.startsWith("file:")) {
    const parentV = safeParam(context.parentURL, "v");
    if (parentV) {
      const url = new URL(result.url);
      if (versioned(url) &&!url.searchParams.get("v")) {
        url.searchParams.set("v", parentV);
        return { ...result, url: url.href, shortCircuit: true };
      }
    }
  }
  return result;
}

export async function load(url, context, nextLoad) {
  const u = new URL(url);
  if (u.protocol === "file:" && TS_RE.test(u.pathname)) {
    const v = u.searchParams.get("v") ?? "0";
    // fileURLToPath decodes %5Bslug%5D and yields D:\... (not /D:/...) on Windows.
    const file = new URL(u);
    file.search = "";
    const fsPath = fileURLToPath(file);
    const endpoint = `${RUST}/__nowaki/ssr-module?path=${encodeURIComponent(fsPath)}&v=${v}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
      throw new Error(`[nowaki] SSR transform failed (${fsPath}): ${await res.text()}`);
    }
    return { format: "module", source: await res.text(), shortCircuit: true };
  }
  return nextLoad(url, context);
}

function safeParam(href, key) {
  try {
    return new URL(href).searchParams.get(key);
  } catch {
    return null;
  }
}
