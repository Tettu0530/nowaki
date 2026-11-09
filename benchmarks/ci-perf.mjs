// CI performance regression gate: the PR (head) against its target branch (base) and against the
// latest release, all measured in the same job, alternating, so runner-to-runner speed differences
// cancel out. Fails when head is clearly slower than base, or slower than the release by more than
// a tighter margin: many small regressions can each pass the base check and still add up over a
// release cycle.
//
// Usage: node benchmarks/ci-perf.mjs --base <checkout> --head <checkout>
//          [--release <checkout>] [--release-label v0.17.3] [--rounds 3]
// Each checkout needs `cargo build --release -p nowaki` done (in <checkout>/target) and its node deps
// installed. A --release that is the same directory as --base is measured once. Needs `oha` on PATH.
// Writes a Markdown table to $GITHUB_STEP_SUMMARY when set.
//
// Every metric runs on benchmarks/ci-perf-app from this script's checkout, copied per side, so all
// sides measure the same app (examples/hello grows with e2e coverage, which isn't a regression).
// Each side uses its own binary and runtime (linked from <checkout>/examples/hello/node_modules):
//   build       `nowaki build` wall time (ms)
//   dev         `nowaki dev` spawn → "ready in" line (ms)
//   about rps   `nowaki start`, GET /about (a plain page), oha -c 50 for 5 s (req/s; higher is better)
//   about ttfb  same server, 300 sequential requests, p50 (ms)
//   post rps    same server, GET /posts/post-7: nested layouts, a dynamic route with a loader, page
//   post ttfb   meta, layout + route CSS and an island, so per-request work in the runtime shows.
// Keep the app to features every compared release supports (0.16.x and later).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
if (!arg("base") || !arg("head")) {
  console.error("usage: node benchmarks/ci-perf.mjs --base <checkout> --head <checkout> [--release <checkout>] [--release-label <tag>] [--rounds 3]");
  process.exit(2);
}
const dirs = { base: path.resolve(arg("base")), head: path.resolve(arg("head")) };
const releaseIsBase = arg("release") && realpathSync(arg("release")) === realpathSync(dirs.base);
if (arg("release") && !releaseIsBase) dirs.release = path.resolve(arg("release"));
const hasRelease = Boolean(arg("release"));
const releaseLabel = arg("release-label", "release");
const SIDES = Object.keys(dirs);
const ROUNDS = Number(arg("rounds", 3));

// How much worse head may be before the gate fails. Times also get an absolute allowance, so a few
// milliseconds of noise on a 60 ms build can't fail it. Against the release, req/s and TTFB are
// tighter: in 38 PR runs (Nov 2026) head vs base req/s moved by 1.5% at the median and 7.4% at p90,
// TTFB by 2.5% / 12.7%; a 17% req/s regression shipped in 0.17.0 in steps that each stayed under 15%.
// A breach triggers as many confirmation rounds again, so one noisy round can't fail the gate alone.
const LIMITS = {
  base: { build: { worse: 0.25, slackMs: 40 }, dev: { worse: 0.25, slackMs: 40 }, rps: { worse: 0.15 }, ttfb: { worse: 0.25, slackMs: 0.05 } },
  release: { build: { worse: 0.25, slackMs: 40 }, dev: { worse: 0.25, slackMs: 40 }, rps: { worse: 0.1 }, ttfb: { worse: 0.2, slackMs: 0.05 } },
};
const METRICS = [
  ["build", "build"],
  ["dev", "dev"],
  ["aboutRps", "rps"],
  ["aboutTtfb", "ttfb"],
  ["postRps", "rps"],
  ["postTtfb", "ttfb"],
];
const LABELS = { build: "build", dev: "dev", aboutRps: "/about req/s", aboutTtfb: "/about TTFB p50", postRps: "/posts/[slug] req/s", postTtfb: "/posts/[slug] TTFB p50" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const bin = (side) => path.join(dirs[side], "target/release/nowaki");
const hello = (side) => path.join(dirs[side], "examples/hello");
let port = 8700;

// The fixture app, copied per side and given that side's node_modules (runtime, preact).
const fixtureSrc = path.join(import.meta.dirname, "ci-perf-app");
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "nowaki-ci-perf-"));
const fixtures = {};
for (const side of SIDES) {
  const dir = path.join(tmpRoot, side);
  cpSync(fixtureSrc, dir, { recursive: true, filter: (p) => !/[\\/](node_modules|dist|\.nowaki)$/.test(p) });
  symlinkSync(path.join(hello(side), "node_modules"), path.join(dir, "node_modules"), "dir");
  fixtures[side] = dir;
}
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

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
  throw new Error(`timed out waiting for ${url} (last status ${last})\n${log()}`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
}

const lastTree = {};
const ls = (d) => spawnSync("find", [d, "-maxdepth", "2"], { encoding: "utf8" }).stdout;
function build(side, app) {
  const t0 = performance.now();
  const r = spawnSync(bin(side), ["build", app], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${side}: nowaki build ${app} failed\n${r.stdout}\n${r.stderr}`);
  lastTree[app] = ls(path.join(app, "dist/server"));
  return performance.now() - t0;
}

async function measureDev(side) {
  const p = port++;
  const t0 = performance.now();
  const child = spawn(bin(side), ["dev", fixtures[side], "--port", String(p)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    return await new Promise((resolve, reject) => {
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
  } finally {
    await stop(child);
  }
}

function oha(args) {
  const r = spawnSync("oha", ["--no-tui", "--output-format", "json", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`oha failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function measureServer(side, app, routes) {
  const p = port++;
  const child = spawn(bin(side), ["start", app, "--port", String(p)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NOWAKI_ISR_WARM: "0" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out = (out + d).slice(-8000)));
  child.stderr.on("data", (d) => (out = (out + d).slice(-8000)));
  // On a timeout, also show what the build left in dist/server, and the source tree, side by side.
  const tree = () =>
    `--- ${app}/dist/server now ---\n${ls(path.join(app, "dist/server"))}\n--- right after the last build ---\n${lastTree[app] ?? ""}\n--- server output (tail) ---\n${out.slice(-2500)}`;
  try {
    const res = [];
    for (const route of routes) {
      const url = `http://127.0.0.1:${p}${route}`;
      await waitFor(url, 30000, tree);
      oha(["-z", "2s", "-c", "50", url]); // warm-up
      const load = oha(["-z", "5s", "-c", "50", url]);
      const seq = oha(["-n", "300", "-c", "1", url]);
      res.push({ rps: load.summary.requestsPerSec, ttfb: seq.latencyPercentiles.p50 * 1000 });
    }
    return res;
  } finally {
    await stop(child);
  }
}

const results = Object.fromEntries(SIDES.map((s) => [s, Object.fromEntries(METRICS.map(([m]) => [m, []]))]));
const label = { base: "base", head: "head", release: releaseLabel };

async function round(n) {
  // Rotate the order each round so no side always runs first or last.
  const order = SIDES.map((_, i) => SIDES[(i + n) % SIDES.length]);
  for (const side of order) {
    const r = results[side];
    r.build.push(build(side, fixtures[side]));
    r.dev.push(await measureDev(side));
    const [about, post] = await measureServer(side, fixtures[side], ["/about", "/posts/post-7"]);
    r.aboutRps.push(about.rps);
    r.aboutTtfb.push(about.ttfb);
    r.postRps.push(post.rps);
    r.postTtfb.push(post.ttfb);
    console.log(
      `round ${n + 1} ${label[side]}: build ${r.build.at(-1).toFixed(0)} ms, dev ${r.dev.at(-1).toFixed(0)} ms, ` +
        `/about ${about.rps.toFixed(0)} req/s ttfb ${about.ttfb.toFixed(3)} ms, ` +
        `/posts/[slug] ${post.rps.toFixed(0)} req/s ttfb ${post.ttfb.toFixed(3)} ms`,
    );
  }
}

function isWorse(kind, h, b, limit) {
  return kind === "rps" ? h < b * (1 - limit.worse) : h > b * (1 + limit.worse) + (limit.slackMs ?? 0);
}

function evaluate() {
  const failures = [];
  for (const [metric, kind] of METRICS) {
    const h = median(results.head[metric]);
    const b = median(results.base[metric]);
    if (isWorse(kind, h, b, LIMITS.base[kind])) failures.push(`${LABELS[metric]} vs base`);
    if (hasRelease) {
      const r = median(results[releaseIsBase ? "base" : "release"][metric]);
      if (isWorse(kind, h, r, LIMITS.release[kind])) failures.push(`${LABELS[metric]} vs ${releaseLabel}`);
    }
  }
  return failures;
}

for (const side of SIDES) {
  build(side, fixtures[side]); // warm caches; also leaves dist/ for start
}
let rounds = 0;
for (; rounds < ROUNDS; rounds++) await round(rounds);
let failures = evaluate();
if (failures.length) {
  console.log(`\nOver the limit after ${ROUNDS} rounds (${failures.join(", ")}); ${ROUNDS} confirmation rounds:`);
  for (; rounds < 2 * ROUNDS; rounds++) await round(rounds);
  failures = evaluate();
}

const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const rows = [];
for (const [metric, kind] of METRICS) {
  const unit = kind === "rps" ? "" : " ms";
  const fmt = (v) => (kind === "ttfb" ? v.toFixed(3) : v.toFixed(0)) + unit;
  const h = median(results.head[metric]);
  const b = median(results.base[metric]);
  const cell = (ref, limit) => {
    const bad = isWorse(kind, h, ref, limit);
    return `${pct((h - ref) / ref)}${bad ? " ❌" : ""}`;
  };
  const cols = [LABELS[metric]];
  if (hasRelease) cols.push(fmt(median(results[releaseIsBase ? "base" : "release"][metric])));
  cols.push(fmt(b), fmt(h), cell(b, LIMITS.base[kind]));
  if (hasRelease) cols.push(cell(median(results[releaseIsBase ? "base" : "release"][metric]), LIMITS.release[kind]));
  rows.push(`| ${cols.join(" | ")} |`);
}
const head = hasRelease
  ? [`| metric | ${releaseLabel}${releaseIsBase ? " (= base)" : ""} | base | head | head vs base | head vs ${releaseLabel} |`, "|---|---:|---:|---:|---:|---:|"]
  : ["| metric | base | head | head vs base |", "|---|---:|---:|---:|"];
const limits = (l) => `req/s −${l.rps.worse * 100}%, TTFB +${l.ttfb.worse * 100}%, build/dev +${l.build.worse * 100}%`;
const note =
  `Median of ${rounds} alternating rounds. Fails beyond: vs base ${limits(LIMITS.base)}` +
  (hasRelease ? `; vs ${releaseLabel} ${limits(LIMITS.release)}.` : ".");
const table = [...head, ...rows].join("\n");
console.log(`\n${table}\n\n${note}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Performance (head vs base${hasRelease ? ` and ${releaseLabel}` : ""})\n\n${table}\n\n${note}\n`);
}
console.log(failures.length ? `PERF GATE FAILED: ${failures.join(", ")}` : "PERF GATE PASSED");
process.exit(failures.length ? 1 : 0);
