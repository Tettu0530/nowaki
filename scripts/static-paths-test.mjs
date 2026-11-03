// Unit test for packages/nowaki-runtime/server/static-paths.mjs (expands `export const staticPaths`).
// Usage: node scripts/static-paths-test.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../packages/nowaki-runtime/server/static-paths.mjs", import.meta.url));
let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const app = (files) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nowaki-static-paths-"));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), src);
  }
  return dir;
};

const ok = app({
  "routes/blog/[slug].js": 'export const staticPaths = [{ slug: "hello" }, { slug: "a b" }];\nexport default () => null;\n',
  "routes/files/[...path].js": 'export const staticPaths = async () => [{ path: ["docs", "intro"] }];\nexport default () => null;\n',
  "routes/users/[id].js": "export default () => null;\n", // no staticPaths: skipped
  "routes/about.js": "export default () => null;\n", // static: not this script's job
});
const pages = JSON.parse(execFileSync("node", [script, ok], { encoding: "utf8" }));
const urls = pages.map((p) => p.url).sort();
check(`expands [slug] and [...path] (${urls.join(", ")})`,
  JSON.stringify(urls) === JSON.stringify(["/blog/a%20b", "/blog/hello", "/files/docs/intro"]));
check("file paths are decoded and end in index.html",
  pages.some((p) => p.url === "/blog/a%20b" && p.file === "blog/a b/index.html"));
rmSync(ok, { recursive: true, force: true });

for (const bad of ["..", "a/b", ""]) {
  const dir = app({ "routes/x/[id].js": `export const staticPaths = [{ id: ${JSON.stringify(bad)} }];\nexport default () => null;\n` });
  const r = spawnSync("node", [script, dir], { encoding: "utf8" });
  check(`rejects param ${JSON.stringify(bad)}`, r.status !== 0 && /invalid value/.test(r.stderr));
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\nSTATIC PATHS TEST FAILED (${failures})` : "\nSTATIC PATHS TEST PASSED");
process.exit(failures ? 1 : 0);
