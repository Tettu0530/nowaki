// Prints `site` from nowaki.config as JSON, for `nowaki build` (nowaki-core runs no JS), which
// writes it to dist/server/site.json for the adapters and the edge.
// Usage: node site-config.mjs   (in the app root)  → {"site":"https://example.com"} or {}
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSite } from "./seo.mjs";

for (const name of ["nowaki.config.mjs", "nowaki.config.js"]) {
  const p = path.join(process.cwd(), name);
  if (!existsSync(p)) continue;
  const mod = await import(pathToFileURL(p).href);
  const site = normalizeSite((mod.default ?? mod.config ?? {}).site);
  process.stdout.write(JSON.stringify(site ? { site } : {}));
  process.exit(0);
}
process.stdout.write("{}");
