// Used by `nowaki prerender`: lists the pages of dynamic routes from each route's
// `export const staticPaths` (an array of params objects, or a function returning one).
// Usage: node static-paths.mjs <dist/server>   → prints [{ url, file, kind? }] as JSON
//   url  — percent-encoded request path, e.g. /blog/a%20b
//   file — decoded path to write under the output dir, e.g. blog/a b/index.html
// File routes (feed.xml.ts, og/[card].png.ts) are listed too, static ones included, with `file`
// being the path itself (og/a.png) and `kind: "file"`, unless they `export const prerender = false`.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { scanRoutes } from "./router.mjs";
import { loadContent } from "./content-load.mjs";
import { compileI18n, localePathFor } from "./i18n.mjs";
import { runWithLocale } from "./i18n-context.mjs";

loadEnv();

const serverDir = path.resolve(process.argv[2] ?? "dist/server");
const i18n = compileI18n(await readFile(path.join(serverDir, "routing.json"), "utf8").then(JSON.parse, () => null));
const { routes } = await scanRoutes(serverDir);
await loadContent(serverDir); // so staticPaths can call getCollection
const pages = [];

for (const route of routes) {
  if (route.fileExt) {
    const mod = await import(pathToFileURL(route.file).href);
    if (mod.prerender === false) continue;
    if (!route.segments.some((s) => s.param)) {
      pages.push(pageFor(route, {}));
      continue;
    }
    let list = mod.staticPaths;
    if (typeof list === "function") list = await list({});
    if (list === undefined) {
      console.error(`[nowaki] ${path.relative(serverDir, route.file)}: a dynamic file route needs \`export const staticPaths\` to be prerendered; skipped`);
      continue;
    }
    if (!Array.isArray(list)) throw new Error(`${route.file}: staticPaths must be an array of params objects`);
    for (const params of list) pages.push(pageFor(route, params ?? {}));
    continue;
  }
  if (route.isApi || !route.segments.some((s) => s.param)) continue;
  const mod = await import(pathToFileURL(route.file).href);
  if (i18n) {
    await localePages(route, mod);
    continue;
  }
  let list = mod.staticPaths;
  if (typeof list === "function") list = await list({});
  if (list === undefined) continue;
  if (!Array.isArray(list)) throw new Error(`${route.file}: staticPaths must be an array of params objects`);
  for (const params of list) pages.push(pageFor(route, params ?? {}));
}

// i18n: a dynamic page in every locale. staticPaths runs once per locale, given `{ locale }` and
// with it as getLocale() (so getCollection returns that locale's entries); each page is requested
// and written under the locale's prefix (`/ja/blog/x` → ja/blog/x/index.html).
async function localePages(route, mod) {
  for (const locale of i18n.locales) {
    let list = mod.staticPaths;
    if (typeof list === "function") list = await runWithLocale({ locale, i18n }, () => list({ locale }));
    if (list === undefined) return;
    if (!Array.isArray(list)) throw new Error(`${route.file}: staticPaths must be an array of params objects`);
    for (const params of list) {
      const page = pageFor(route, params ?? {});
      const url = localePathFor(i18n, page.url, locale);
      const dir = url === page.url ? "" : `${locale}/`;
      pages.push({ url, file: dir + page.file });
    }
  }
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
      const suffix = seg.suffix ?? "";
      url.push(encodeURIComponent(s) + suffix);
      file.push(s + suffix);
    }
  }
  if (route.fileExt) return { url: "/" + url.join("/"), file: file.join("/"), kind: "file" };
  return { url: "/" + url.join("/"), file: [...file, "index.html"].join("/") };
}
