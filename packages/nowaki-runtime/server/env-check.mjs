// Used by `nowaki build` / `dev` / `prerender` before the build: validates the environment against
// the app's env.ts (the schemas are JavaScript). Prints one line per problem and exits 1, or prints
// the validated public values the client build inlines (never the server ones):
//   NOWAKI_ENV_OK [["PUBLIC_X", "<JSON literal>"], ...]
// Usage: node env-check.mjs <env.ts>
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { envDefinition, validateEnv } from "./env-schema.mjs";

const fail = (lines) => {
  for (const l of lines) console.error(`[nowaki] env: ${l}`);
  process.exit(1);
};

loadEnv();
const file = path.resolve(process.argv[2] ?? "env.ts");
let mod;
try {
  mod = await import(pathToFileURL(file).href);
} catch (err) {
  if (err?.code === "ERR_UNKNOWN_FILE_EXTENSION" && /\.m?ts$/.test(file)) {
    fail([`${path.basename(file)} needs Node 22.18 or newer (TypeScript type stripping), or write it as env.js`]);
  }
  fail([`failed to load ${path.basename(file)}: ${err?.stack ?? err}`]);
}
let def;
try {
  def = envDefinition(mod);
} catch (err) {
  fail([err.message]);
}
const { values, errors } = await validateEnv(def, process.env);
for (const [name, v] of Object.entries(values.public)) {
  const t = typeof v;
  const plain = v === undefined || v === null || t === "string" || t === "number" || t === "boolean";
  if (!plain || (t === "number" && !Number.isFinite(v))) {
    errors.push(`${name}: a public value must be a string, number, boolean, or null to be inlined into client code`);
  }
}
if (errors.length) fail(errors);
const pairs = Object.entries(values.public).map(([k, v]) => [k, v === undefined ? "undefined" : JSON.stringify(v)]);
console.log(`NOWAKI_ENV_OK ${JSON.stringify(pairs)}`);
