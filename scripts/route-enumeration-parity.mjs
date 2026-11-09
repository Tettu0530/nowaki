// Prints sorted page URL patterns and parallel-route slot patterns (intercept targets included)
// from scanRoutes, for parity with nowaki-core::routes (page_url_patterns, slot_route_patterns).
// Usage: node scripts/route-enumeration-parity.mjs [appRoot]
// stdout: JSON { pages: string[], slots: string[] }

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
        return `[${seg.param}]${seg.suffix ?? ""}`;
      })
      .join("/")
  );
}

const table = await scanRoutes(ROOT);
const pages = table.routes
  .filter((r) => !r.isApi)
  .map((r) => urlFromSegments(r.segments))
  .sort();
const slots = [];
for (const slot of table.slots) {
  const name = `${slot.ownerDir}/@${slot.name}`;
  for (const r of slot.routes) slots.push(`${name} ${urlFromSegments(r.segments)}`);
  if (slot.default) slots.push(`${name} default`);
  for (const i of slot.intercepts) if (i.pattern) slots.push(`${name} intercept ${i.pattern}`);
}
slots.sort();
process.stdout.write(`${JSON.stringify({ pages, slots })}\n`);
