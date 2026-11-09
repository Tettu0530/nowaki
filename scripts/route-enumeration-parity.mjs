// Prints sorted page URL patterns from scanRoutes (non-API) for parity with nowaki-core::routes.
// Usage: node scripts/route-enumeration-parity.mjs [appRoot]
// stdout: JSON string array

import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRoutes } from "../packages/nowaki-runtime/server/router.mjs";

const ROOT = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

function urlFromSegments(segments) {
  if (segments.length === 0) return "/";
  return (
    "/" +
    segments
      .map((seg) => {
        if (seg.lit !== undefined) return seg.lit;
        if (seg.rest) return `[...${seg.param}]`;
        return `[${seg.param}]`;
      })
      .join("/")
  );
}

const table = await scanRoutes(ROOT);
const urls = table.routes
  .filter((r) => !r.isApi && (r.slot ?? "children") === "children")
  .map((r) => urlFromSegments(r.segments))
  .sort();
process.stdout.write(`${JSON.stringify(urls)}\n`);
