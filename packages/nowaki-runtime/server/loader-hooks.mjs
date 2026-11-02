// Node module loader hooks. To keep Rust as the single transformer, .tsx/.ts are
// fetched from the Rust dev server's transform endpoint and returned as ESM (vite-node style).

import { fileURLToPath } from "node:url";

const RUST = `http://127.0.0.1:${process.env.NOWAKI_RUST_PORT ?? "3000"}`;
const TS_RE = /\.(tsx|ts|jsx|tsrx)$/;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  // propagate the parent module's ?v= (HMR generation) to relative imports to force re-evaluation after changes
  if (context.parentURL && result.url.startsWith("file:")) {
    const parentV = safeParam(context.parentURL, "v");
    if (parentV) {
      const url = new URL(result.url);
      if (TS_RE.test(url.pathname) && !url.searchParams.get("v")) {
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
