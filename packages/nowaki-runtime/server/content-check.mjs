// Used by `nowaki build`: validates every content entry against content/config (Rust renders the
// Markdown, but the schemas are JavaScript). Prints one line per problem and exits 1 if any.
// Usage: node content-check.mjs <dist/server>
import path from "node:path";
import { loadEnv } from "./env.mjs";
import { loadContent } from "./content-load.mjs";

loadEnv();
const { collections, errors } = (await loadContent(path.resolve(process.argv[2] ?? "dist/server"))) ?? {
  collections: {},
  errors: ["content/index.json not found (run nowaki build)"],
};
if (errors.length) {
  for (const e of errors) console.error(`[nowaki] content: ${e}`);
  process.exit(1);
}
const counts = Object.entries(collections).map(([n, es]) => `${n} ${es.length}`);
console.log(`NOWAKI_CONTENT_OK ${counts.join(", ")}`);
