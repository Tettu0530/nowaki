// Prints the build-time parts of nowaki.config as JSON, for `nowaki build` / `nowaki dev`
// (nowaki-core runs no JS): `site` (normalized) and `fonts` (as written).
// Usage: node site-config.mjs   (in the app root)  → {"site":"https://example.com","fonts":[…]}
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSite } from "./seo.mjs";

let out = {};
for (const name of ["nowaki.config.mjs", "nowaki.config.js"]) {
  const p = path.join(process.cwd(), name);
  if (!existsSync(p)) continue;
  const mod = await import(pathToFileURL(p).href);
  const config = mod.default ?? mod.config ?? {};
  const site = normalizeSite(config.site);
  if (site) out.site = site;
  if (Array.isArray(config.fonts) && config.fonts.length) out.fonts = config.fonts;
  break;
}
process.stdout.write(JSON.stringify(out));
