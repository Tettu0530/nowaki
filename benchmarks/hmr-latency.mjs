// HMR update latency for the 1.0 target (HMR update < 100 ms): runs scripts/hmr-browser-test.mjs
// N times (Chrome over CDP on `nowaki dev`; file written -> DOM updated, per kind of edit) and
// reports every sample per kind with its median and p90. The test itself checks each update is
// correct; a failed run is reported and its samples are left out.
//
// Usage: [NOWAKI_BIN=path] node benchmarks/hmr-latency.mjs [--runs 5] [--out benchmarks/results/hmr.jsonl]
//   NOWAKI_BIN  the binary under test (default target/debug/nowaki, as in the test; measure a
//               release binary)
// The test app links examples/hello's node_modules, so the runtime is the repo's.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const RUNS = Number(arg("runs", 5));
const OUT = path.resolve(arg("out", path.join(ROOT, "benchmarks/results/hmr.jsonl")));
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki");
const version = spawnSync(BIN, ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^nowaki /, "");
const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const commit = `${git(["rev-parse", "--short", "HEAD"])}${git(["status", "--porcelain", "--", "crates", "packages", "scripts/hmr-browser-test.mjs"]) ? "+dirty" : ""}`;
const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}, node ${process.version}`;
const series = new Date().toISOString();

mkdirSync(path.dirname(OUT), { recursive: true });
const samples = {};
let failed = 0;
console.log(`HMR latency: nowaki ${version} · ${RUNS} runs · ${machine} · ${commit}`);
for (let run = 1; run <= RUNS; run++) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/hmr-browser-test.mjs")], {
    cwd: ROOT,
    env: { ...process.env, NOWAKI_BIN: BIN },
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  const out = `${r.stdout}`;
  if (r.status !== 0) {
    failed++;
    console.log(`  run ${run}: FAILED (exit ${r.status})\n${out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}`);
    continue;
  }
  const at = out.indexOf("HMR latency (file written -> DOM updated), ms:");
  const lines = out.slice(at).split("\n").slice(1);
  const got = {};
  for (const line of lines) {
    const m = line.match(/^ {2}(.+?)\s+median\s+\d+\s+\[([\d, ]*)\]$/);
    if (!m) continue;
    got[m[1].trim()] = m[2].split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  }
  for (const [kind, xs] of Object.entries(got)) (samples[kind] ??= []).push(...xs);
  appendFileSync(OUT, `${JSON.stringify({ run, version, latencies: got, series, at: new Date().toISOString(), machine, commit })}\n`);
  console.log(`  run ${run}: ${Object.keys(got).length} kinds`);
}

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
console.log(`\nHMR latency over ${RUNS - failed} runs (file written -> DOM updated), ms:`);
for (const [kind, xs] of Object.entries(samples)) {
  console.log(`  ${kind.padEnd(28)} median ${String(q(xs, 0.5)).padStart(4)} · p90 ${String(q(xs, 0.9)).padStart(4)} · n ${xs.length}${q(xs, 0.5) < 100 ? "" : "  (over the 100 ms target)"}`);
}
if (failed) console.log(`\n${failed} of ${RUNS} runs failed`);
process.exit(failed ? 1 : 0);
