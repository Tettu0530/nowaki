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
const run = (dir) => JSON.parse(execFileSync("node", [script, dir], { encoding: "utf8" }));
const runFail = (dir) => spawnSync("node", [script, dir], { encoding: "utf8" });

const ok = app({
  "routes/blog/[slug].js": 'export const staticPaths = [{ slug: "hello" }, { slug: "a b" }];\nexport default () => null;\n',
  "routes/files/[...path].js": 'export const staticPaths = async () => [{ path: ["docs", "intro"] }];\nexport default () => null;\n',
  "routes/users/[id].js": "export default () => null;\n", // no staticPaths: skipped
  "routes/about.js": "export default () => null;\n", // static: not this script's job
});
const pages = run(ok);
const urls = pages.map((p) => p.url).sort();
check(
  `expands [slug] and [...path] (${urls.join(", ")})`,
  JSON.stringify(urls) === JSON.stringify(["/blog/a%20b", "/blog/hello", "/files/docs/intro"]),
);
check(
  "file paths are decoded and end in index.html",
  pages.some((p) => p.url === "/blog/a%20b" && p.file === "blog/a b/index.html"),
);
rmSync(ok, { recursive: true, force: true });

for (const bad of ["..", "a/b", "", ".", "a\\b"]) {
  const dir = app({
    "routes/x/[id].js": `export const staticPaths = [{ id: ${JSON.stringify(bad)} }];\nexport default () => null;\n`,
  });
  const r = runFail(dir);
  check(`rejects param ${JSON.stringify(bad)}`, r.status !== 0 && /invalid value/.test(r.stderr));
  rmSync(dir, { recursive: true, force: true });
}

const missing = app({
  "routes/y/[id].js": "export const staticPaths = [{}];\nexport default () => null;\n",
});
const rMissing = runFail(missing);
check("rejects missing param (empty segment)", rMissing.status !== 0 && /invalid value/.test(rMissing.stderr));
rmSync(missing, { recursive: true, force: true });

const syncFn = app({
  "routes/sync/[slug].js": 'export const staticPaths = () => [{ slug: "from-fn" }];\nexport default () => null;\n',
});
const syncPages = run(syncFn);
check("sync staticPaths function expands", syncPages.length === 1 && syncPages[0].url === "/sync/from-fn");
rmSync(syncFn, { recursive: true, force: true });

const twoSeg = app({
  "routes/shop/[category]/[id].js":
    'export const staticPaths = [{ category: "books", id: "42" }];\nexport default () => null;\n',
});
const twoPages = run(twoSeg);
check(
  "two dynamic segments in one route",
  twoPages.length === 1 && twoPages[0].url === "/shop/books/42" && twoPages[0].file === "shop/books/42/index.html",
);
rmSync(twoSeg, { recursive: true, force: true });

const catchMulti = app({
  "routes/files/[...path].js":
    'export const staticPaths = [{ path: ["a", "b"] }, { path: ["c"] }];\nexport default () => null;\n',
});
const catchUrls = run(catchMulti)
  .map((p) => p.url)
  .sort();
check(
  "catch-all expands multiple staticPaths entries",
  JSON.stringify(catchUrls) === JSON.stringify(["/files/a/b", "/files/c"]),
);
rmSync(catchMulti, { recursive: true, force: true });

const emptyList = app({
  "routes/empty/[slug].js": "export const staticPaths = [];\nexport default () => null;\n",
  "routes/one/[slug].js": 'export const staticPaths = [{ slug: "only" }];\nexport default () => null;\n',
});
const emptyPages = run(emptyList);
check(
  "empty staticPaths array adds no pages for that route",
  emptyPages.length === 1 && emptyPages[0].url === "/one/only",
);
rmSync(emptyList, { recursive: true, force: true });

const apiSkip = app({
  "routes/api/items/[id].js": 'export const staticPaths = [{ id: "secret" }];\nexport default () => null;\n',
});
const apiPages = run(apiSkip);
check("API routes are not expanded even with staticPaths", apiPages.length === 0);
rmSync(apiSkip, { recursive: true, force: true });

const notArray = app({
  "routes/bad/[slug].js": 'export const staticPaths = { slug: "x" };\nexport default () => null;\n',
});
const rBad = runFail(notArray);
check(
  "staticPaths must be an array",
  rBad.status !== 0 && /must be an array/.test(rBad.stderr),
);
rmSync(notArray, { recursive: true, force: true });

const encoded = app({
  "routes/q/[slug].js": 'export const staticPaths = [{ slug: "a&b" }];\nexport default () => null;\n',
});
const encPages = run(encoded);
check(
  "url path segments are percent-encoded",
  encPages.length === 1 && encPages[0].url === "/q/a%26b" && encPages[0].file === "q/a&b/index.html",
);
rmSync(encoded, { recursive: true, force: true });

console.log(failures ? `\nSTATIC PATHS TEST FAILED (${failures})` : "\nSTATIC PATHS TEST PASSED");
process.exit(failures ? 1 : 0);
