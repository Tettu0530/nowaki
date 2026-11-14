// Regression gate on client JS size (shipped JS is deterministic, so it can gate).
// Timings vary by machine, so they don't gate (head-to-head.mjs measures them for reference).
// Usage:
//   node benchmarks/check-regression.mjs           # compare against baseline.json (exit 1 if exceeded)
//   node benchmarks/check-regression.mjs --update   # update baseline.json with current values
// Target is benchmarks/apps/nowaki-counter (minimal, stable). Threshold is gzip +12%.
// Needs a built binary (target/release/nowaki, else target/debug/nowaki). CI runs it in the bench-regression job.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "benchmarks/apps/nowaki-counter");
const BASELINE = path.join(ROOT, "benchmarks/baseline.json");
const TOLERANCE = 0.12; // allowed gzip size increase ratio
const UPDATE = process.argv.includes("--update");

const bin = existsSync(path.join(ROOT, "target/release/nowaki"))
  ? path.join(ROOT, "target/release/nowaki")
  : path.join(ROOT, "target/debug/nowaki");

function measure() {
  rmSync(path.join(APP, "dist"), { recursive: true, force: true });
  const r = spawnSync(bin, ["build", APP], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error("build failed:\n", r.stderr ?? r.stdout);
    process.exit(2);
  }
  const clientDir = path.join(APP, "dist/client");
  const manifest = JSON.parse(readFileSync(path.join(clientDir, "manifest.json"), "utf8"));
  // The SPA router (routerRuntime + manifest.preload transitive deps) loads on link intent
  // and isn't part of first load, so it's excluded from the gated value (gzipBytes).
  const lazySet = new Set();
  if (manifest.routerRuntime) {
    lazySet.add(manifest.routerRuntime);
    for (const dep of manifest.preload?.[manifest.routerRuntime] ?? []) lazySet.add(dep);
  }
  let gz = 0; // eager first-load
  let lazyGz = 0; // lazy router chunks (for reference)
  let jsFiles = 0;
  for (const f of readdirSync(clientDir)) {
    if (!f.endsWith(".js")) continue;
    jsFiles += 1;
    const bytes = gzipSync(readFileSync(path.join(clientDir, f))).length;
    if (lazySet.has(f)) lazyGz += bytes;
    else gz += bytes;
  }
  const islands = Object.keys(manifest.islands ?? {}).length;
  rmSync(path.join(APP, "dist"), { recursive: true, force: true });
  return { gzipBytes: gz, lazyBytes: lazyGz, jsFiles, islands };
}

const cur = measure();

if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n");
  console.log(`baseline ${UPDATE ? "updated" : "created"}:`, cur);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const limit = Math.ceil(base.gzipBytes * (1 + TOLERANCE));
const kb = (b) => (b / 1024).toFixed(2);

let failed = false;
console.log(`first-load JS (gzip): ${kb(cur.gzipBytes)} KB  (baseline ${kb(base.gzipBytes)} KB, limit ${kb(limit)} KB)`);
if (cur.lazyBytes) {
  console.log(`  + SPA router (loaded on link intent, not first-load): ${kb(cur.lazyBytes)} KB`);
}
if (cur.gzipBytes > limit) {
  console.error(`REGRESSION: shipped JS grew >${TOLERANCE * 100}% over baseline`);
  failed = true;
}
// Also report structural changes (chunk/island counts): not fatal, but a cue to update the baseline.
if (cur.jsFiles !== base.jsFiles) {
  console.warn(`note: client chunk count ${base.jsFiles} → ${cur.jsFiles}`);
}
if (cur.islands !== base.islands) {
  console.warn(`note: island count ${base.islands} → ${cur.islands}`);
}

if (failed) {
  console.error("If this growth is intentional, run `node benchmarks/check-regression.mjs --update`.");
  process.exit(1);
}
console.log("OK: no client-JS size regression.");
process.exit(0);
