// Used by `nowaki prerender`: lists the pages of dynamic routes from each route's
// `export const staticPaths` (an array of params objects, or a function returning one).
// Usage: node static-paths.mjs <dist/server>   → prints [{ url, file }] as JSON
//   url  — percent-encoded request path, e.g. /blog/a%20b
//   file — decoded path to write under the output dir, e.g. blog/a b/index.html

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { scanRoutes } from "./router.mjs";

loadEnv();

const serverDir = path.resolve(process.argv[2] ?? "dist/server");
const { routes } = await scanRoutes(serverDir);
const pages = [];

for (const route of routes) {
  if (route.isApi || !route.segments.some((s) => s.param)) continue;
  const mod = await import(pathToFileURL(route.file).href);
  let list = mod.staticPaths;
  if (typeof list === "function") list = await list();
  if (list === undefined) continue;
  if (!Array.isArray(list)) throw new Error(`${route.file}: staticPaths must be an array of params objects`);
  for (const params of list) pages.push(pageFor(route, params ?? {}));
}

process.stdout.write(JSON.stringify(pages));

function pageFor(route, params) {
  const url = [];
  const file = [];
  for (const seg of route.segments) {
    if (seg.lit !== undefined) {
      url.push(seg.lit);
      file.push(seg.lit);
      continue;
    }
    const value = params[seg.param];
    const parts = seg.rest ? (Array.isArray(value) ? value : [value]) : [value];
    for (const part of parts) {
      const s = part === undefined || part === null ? "" : String(part);
      // These would escape the output dir or collapse into another page.
      if (s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\")) {
        throw new Error(`${route.file}: staticPaths param "${seg.param}" has an invalid value ${JSON.stringify(part)}`);
      }
      url.push(encodeURIComponent(s));
      file.push(s);
    }
  }
  return { url: "/" + url.join("/"), file: [...file, "index.html"].join("/") };
}
