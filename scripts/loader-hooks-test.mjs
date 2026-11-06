// Unit tests for server/loader-hooks.mjs resolve(): which modules get the parent's ?v= (HMR
// generation), so dev SSR re-evaluates them after an edit.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, resolve } from "../packages/nowaki-runtime/server/loader-hooks.mjs";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "nowaki-hooks-")));
const root = path.join(base, "app");
initialize({ root });
const href = (p) => pathToFileURL(p).href;
const parentURL = href(path.join(root, "routes/index.tsx")) + "?v=7";
const resolved = async (file) => (await resolve("x", { parentURL }, async () => ({ url: href(file) }))).url;
const v = async (file) => new URL(await resolved(file)).searchParams.get("v");

check("a .tsx app module gets the generation", (await v(path.join(root, "lib/a.tsx"))) === "7");
check("a plain .js app module gets the generation", (await v(path.join(root, "lib/msg.js"))) === "7");
check("an .mjs app module gets the generation", (await v(path.join(root, "lib/x.mjs"))) === "7");
check("a .js file in node_modules does not (one copy of preact)", (await v(path.join(root, "node_modules/preact/dist/preact.mjs"))) === null);
check("a .js file outside the app root does not (workspace runtime)", (await v(path.join(base, "packages/nowaki-runtime/server/functions.mjs"))) === null);
check("a .json app file does not", (await v(path.join(root, "data/site.json"))) === null);
const noParent = await resolve("x", { parentURL: href(path.join(root, "routes/index.tsx")) }, async () => ({ url: href(path.join(root, "lib/msg.js")) }));
check("without a parent generation nothing is added", new URL(noParent.url).search === "");

console.log(failures ? `\nLOADER HOOKS TEST FAILED (${failures})` : "\nLOADER HOOKS TEST PASSED");
process.exit(failures ? 1 : 0);
