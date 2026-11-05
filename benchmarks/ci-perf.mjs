// CI performance regression gate: the PR (head) against its target branch (base), measured in the
// same job, alternating, so runner-to-runner speed differences cancel out. Fails when head is
// clearly slower than base on any metric.
//
// Usage: node benchmarks/ci-perf.mjs --base <checkout> --head <checkout> [--rounds 3]
// Each checkout needs `cargo build --release -p nowaki` done and its node deps installed.
// Needs `oha` on PATH. Writes a Markdown table to $GITHUB_STEP_SUMMARY when set.
//
// Metrics, all on <checkout>/examples/hello with that checkout's binary and runtime:
//   build     `nowaki build` wall time (ms)
//   dev       `nowaki dev` spawn → "ready in" line (ms)
//   rps       `nowaki start`, GET /about, oha -c 50 for 5 s (req/s; higher is better)
//   ttfb      `nowaki start`, GET /about, 300 sequential requests, p50 (ms)
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const sides = { base: path.resolve(arg("base", "")), head: path.resolve(arg("head", "")) };
if (!arg("base") || !arg("head")) {
  console.error("usage: node benchmarks/ci-perf.mjs --base <checkout> --head <checkout> [--rounds 3]");
  process.exit(2);
}
const ROUNDS = Number(arg("rounds", 3));
// How much worse head may be before the gate fails. Times also get an absolute allowance, so a
// few milliseconds of noise on a 60 ms build can't fail it.
const LIMITS = {
  build: { worse: 0.25, slackMs: 40 },
  dev: { worse: 0.25, slackMs: 40 },
  rps: { worse: 0.15 },
  ttfb: { worse: 0.25, slackMs: 0.05 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const bin = (side) => path.join(sides[side], "target/release/nowaki");
const app = (side) => path.join(sides[side], "examples/hello");
let port = 8700;

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    req.setTimeout(2000, () => req.destroy());
  });
}

// `log()` returns what the server printed, shown when it never answers 200.
async function waitFor(url, ms = 30000, log = () => "") {
  const end = Date.now() + ms;
  let last = 0;
  while (Date.now() < end) {
    last = await get(url);
    if (last === 200) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url} (last status ${last})\n--- server output (tail) ---\n${log().slice(-4000)}`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
}

function measureBuild(side) {
  const t0 = performance.now();
  const r = spawnSync(bin(side), ["build", app(side)], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`${side}: nowaki build failed`);
  return performance.now() - t0;
}

async function measureDev(side) {
  const p = port++;
  const t0 = performance.now();
  const child = spawn(bin(side), ["dev", app(side), "--port", String(p)], { stdio: ["ignore", "pipe", "pipe"] });
  const ms = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${side}: dev never printed "ready in"`)), 30000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("ready in")) {
        clearTimeout(timer);
        resolve(performance.now() - t0);
      }
    });
  });
  await stop(child);
  return ms;
}

function oha(args) {
  const r = spawnSync("oha", ["--no-tui", "--output-format", "json", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`oha failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function measureServer(side) {
  const p = port++;
  const child = spawn(bin(side), ["start", app(side), "--port", String(p)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NOWAKI_ISR_WARM: "0" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out = (out + d).slice(-8000)));
  child.stderr.on("data", (d) => (out = (out + d).slice(-8000)));
  const url = `http://127.0.0.1:${p}/about`;
  try {
    await waitFor(url, 30000, () => out);
    oha(["-z", "2s", "-c", "50", url]); // warm-up
    const load = oha(["-z", "5s", "-c", "50", url]);
    const seq = oha(["-n", "300", "-c", "1", url]);
    return { rps: load.summary.requestsPerSec, ttfb: seq.latencyPercentiles.p50 * 1000 };
  } finally {
    await stop(child);
  }
}

const results = { base: { build: [], dev: [], rps: [], ttfb: [] }, head: { build: [], dev: [], rps: [], ttfb: [] } };
for (const side of ["base", "head"]) measureBuild(side); // warm caches; also leaves dist/ for start
for (let round = 0; round < ROUNDS; round++) {
  const order = round % 2 === 0 ? ["base", "head"] : ["head", "base"];
  for (const side of order) {
    results[side].build.push(measureBuild(side));
    results[side].dev.push(await measureDev(side));
    const s = await measureServer(side);
    results[side].rps.push(s.rps);
    results[side].ttfb.push(s.ttfb);
    console.log(`round ${round + 1} ${side}: build ${results[side].build.at(-1).toFixed(0)} ms, dev ${results[side].dev.at(-1).toFixed(0)} ms, ${s.rps.toFixed(0)} req/s, ttfb p50 ${s.ttfb.toFixed(3)} ms`);
  }
}

const rows = [];
let failed = 0;
for (const [metric, limit] of Object.entries(LIMITS)) {
  const b = median(results.base[metric]);
  const h = median(results.head[metric]);
  const higherIsBetter = metric === "rps";
  const change = (h - b) / b;
  const worse = higherIsBetter ? h < b * (1 - limit.worse) : h > b * (1 + limit.worse) + (limit.slackMs ?? 0);
  if (worse) failed++;
  const unit = metric === "rps" ? "req/s" : "ms";
  const fmt = (v) => (metric === "ttfb" ? v.toFixed(3) : v.toFixed(0));
  rows.push(`| ${metric} | ${fmt(b)} ${unit} | ${fmt(h)} ${unit} | ${(change * 100).toFixed(1)}% | ${worse ? "❌ worse than allowed" : "ok"} |`);
}
const table = ["| metric | base | head | change | |", "|---|---|---|---|---|", ...rows].join("\n");
console.log(`\n${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Performance (head vs base, median of ${ROUNDS}, alternating)\n\n${table}\n`);
}
console.log(failed ? `PERF GATE FAILED (${failed} metric(s) regressed)` : "PERF GATE PASSED");
process.exit(failed ? 1 : 0);
