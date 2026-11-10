// Production server benchmark: each framework's own Node server for the server-mode build.
// Usage: node benchmarks/compare/prod.mjs <framework> [--pages 100] [--islands 1] [--runs 3] [--isr]
//        [--label name] [--env KEY=VALUE,...]
// Needs `oha` (https://github.com/hatoo/oha) for the throughput step.
//
// Each run builds once, then starts the server fresh and measures, one process at a time:
//   startMs      spawn → GET / answers 200 with the home marker
//   latency      300 sequential GETs (one connection, keep-alive) over 90 post pages:
//                ttfb (response headers) and total (body received), p50 / p99 in ms
//   throughput   oha, 50 connections for 10 s, after a 3 s warm-up at the same load:
//                post pages (random slug per request), `/`, and the JSON API /api/search?q=;
//                req/s, p50 / p99, non-2xx count
//   memory       RSS of the server's whole process tree (MB): idle after the warm-up, and the
//                peak sampled every 100 ms during the post-page throughput step
// Pages are rendered per request (no ISR or page cache), unless --isr: then post pages use the
// framework's own ISR, revalidated every 60 s (Nowaki, Next.js, Nuxt; Astro and SvelteKit have none).

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { generate, APPS } from "./gen.mjs";
import { posts } from "./lib/content.mjs";
import { FRAMEWORKS, ORDER } from "./lib/frameworks.mjs";
import { MARK_HOME, MARK_POST, V018_BASE } from "./lib/templates.mjs";

const HERE = import.meta.dirname;
const RESULTS = process.env.COMPARE_RESULTS ? path.resolve(process.env.COMPARE_RESULTS) : path.join(HERE, "results");
const PORT = 8940;
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const fwName = process.argv[2];
const fw = FRAMEWORKS[fwName];
if (!fw) {
  console.error(`usage: node benchmarks/compare/prod.mjs <${ORDER.join("|")}> [--pages N] [--islands N] [--runs N] [--label L] [--env K=V,...] [--isr] [--v018 rules,basePath,i18n,session,env]`);
  process.exit(2);
}
const pages = Number(arg("pages", 100));
const islands = Number(arg("islands", 1));
const RUNS = Number(arg("runs", 3));
const isr = process.argv.includes("--isr");
const label = arg("label", isr ? `${fwName}+isr` : fwName);
const extraEnv = Object.fromEntries(
  (arg("env", "") || "")
    .split(",")
    .filter(Boolean)
    .map((kv) => kv.split("=")),
);
// Nowaki 0.18 features to turn on in the app (comma-separated: rules,basePath,i18n,session,env;
// see nowakiV018 in lib/templates.mjs). Recorded with each row.
const v018List = (arg("v018", "") || "").split(",").filter(Boolean);
const V018_KNOWN = ["rules", "basePath", "i18n", "session", "env"];
for (const k of v018List) if (!V018_KNOWN.includes(k)) throw new Error(`--v018: unknown feature ${k} (known: ${V018_KNOWN.join(", ")})`);
if (v018List.length && fwName !== "nowaki") throw new Error("--v018 applies to nowaki only");
const v018 = Object.fromEntries(v018List.map((k) => [k, true]));
const BASE = v018.basePath ? V018_BASE : "";
const HOME_PATH = BASE || "/";
// Isolating the session's cost: --no-session-cookie keeps session.ts but sends no cookie;
// --cookie NAME=VALUE sends a fixed cookie on every request (with or without session.ts).
const sendSessionCookie = !process.argv.includes("--no-session-cookie");
const fixedCookie = arg("cookie", null);

// How each framework's production server is started (server-mode build output).
// Nowaki's npm `nowaki` command is a Node shim that spawnSyncs the Rust binary and stays
// resident (~45 MB); no other framework has such a launcher, so the binary is started directly.
// NOWAKI_BIN points at another binary (a release build of the repo) for A/B runs; it builds and
// serves the app in place of the installed CLI.
const nowakiBinary = () =>
  process.env.NOWAKI_BIN
    ? path.resolve(process.env.NOWAKI_BIN)
    : createRequire(path.join(APPS, "nowaki/node_modules/nowaki/package.json"))("./lib/resolve.js").resolveBinary();
const SERVERS = {
  nowaki: { cmd: () => [nowakiBinary(), ["start", ".", "--port", String(PORT)]] },
  astro: { cmd: () => [process.execPath, ["dist/server/entry.mjs"]] },
  sveltekit: { cmd: () => [process.execPath, ["build/index.js"]] },
  next: { cmd: (bin) => [bin, ["start", "-p", String(PORT), "-H", "127.0.0.1"]] },
  nuxt: { cmd: () => [process.execPath, [".output/server/index.mjs"]] },
};

const dir = path.join(APPS, fwName);
const bin = fwName === "nowaki" && process.env.NOWAKI_BIN ? nowakiBinary() : path.join(dir, "node_modules/.bin", fw.bin);
if (!existsSync(bin)) {
  console.error(`${fw.label} is not installed: pnpm -C benchmarks/compare/apps/${fwName} install --frozen-lockfile`);
  process.exit(2);
}
if (spawnSync("oha", ["--version"]).status !== 0) {
  console.error("oha is not installed (brew install oha, or cargo install oha)");
  process.exit(2);
}
const version =
  fwName === "nowaki" && process.env.NOWAKI_BIN
    ? spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^nowaki /, "")
    : JSON.parse(readFileSync(path.join(dir, "node_modules", fw.versionPkg, "package.json"), "utf8")).version;
// The runtime the app resolves (Nowaki only).
const runtimePkg = path.join(dir, "node_modules/@nowaki-dev/runtime/package.json");
const runtime = fwName === "nowaki" && existsSync(runtimePkg) ? JSON.parse(readFileSync(runtimePkg, "utf8")).version : undefined;
const env = {
  ...process.env,
  ...fw.env,
  ...(v018.session ? { NOWAKI_SESSION_SECRET: "bench-session-secret-0123456789abcdef0123" } : {}),
  ...extraEnv,
  NODE_ENV: "production",
  PORT: String(PORT),
  HOST: "127.0.0.1",
  NITRO_HOST: "127.0.0.1",
  NITRO_PORT: String(PORT),
  // The public origin, as a deployment would set it (SvelteKit reads it at build time).
  ORIGIN: `http://127.0.0.1:${PORT}`,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};
const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}, node ${process.version}`;
const git = (args) => spawnSync("git", args, { cwd: HERE, encoding: "utf8" }).stdout.trim();
const commit = `${git(["rev-parse", "--short", "HEAD"])}${git(["status", "--porcelain", "--", ".", ":!results"]) ? "+dirty" : ""}`;
const ohaVersion = spawnSync("oha", ["--version"], { encoding: "utf8" }).stdout.trim();
const series = new Date().toISOString();
const slugs = posts(pages).map((p) => p.slug);
// 90 of the posts: the latency loop walks them in order; oha picks one at random per request.
const pool = slugs.slice(0, Math.min(90, slugs.length));
// A query that matches (titles are "Post N: ...").
const API_PATH = `${BASE}/api/search?q=post%201`;
const urlFile = path.join(os.tmpdir(), `compare-prod-urls-${process.pid}.txt`);
writeFileSync(urlFile, pool.map((s) => `http://127.0.0.1:${PORT}${BASE}/posts/${s}`).join("\n") + "\n");

mkdirSync(RESULTS, { recursive: true });
const record = (row) =>
  appendFileSync(
    path.join(RESULTS, "prod.jsonl"),
    `${JSON.stringify({ framework: fwName, label, fwLabel: fw.label, version, runtime, v018: v018List, cookie: fixedCookie ? "fixed" : v018.session && sendSessionCookie ? "session" : "none", pages, islands, env: extraEnv, isr, ...row, series, at: new Date().toISOString(), machine, commit, oha: ohaVersion })}\n`,
  );

function rssTreeMB(pgid) {
  const out = spawnSync("ps", ["-A", "-o", "pgid=,rss="], { encoding: "utf8" }).stdout;
  let kb = 0;
  for (const line of out.trim().split("\n")) {
    const [g, rss] = line.trim().split(/\s+/).map(Number);
    if (g === pgid) kb += rss;
  }
  return Math.round((kb / 1024) * 10) / 10;
}

// CPU time (user + system, ms) of every live process in the server's process group: the server
// and any Node sidecar it starts. Divided by the requests served, it is the server's own cost per
// request, which other load on the machine moves far less than req/s.
function cpuTreeMs(pgid) {
  const out = spawnSync("ps", ["-A", "-o", "pgid=,time="], { encoding: "utf8" }).stdout;
  let ms = 0;
  for (const line of out.trim().split("\n")) {
    const [g, t] = line.trim().split(/\s+/);
    if (Number(g) !== pgid) continue;
    // [[dd-]hh:]mm:ss.cc
    const [days, clock] = t.includes("-") ? t.split("-") : ["0", t];
    const parts = clock.split(":").map(Number);
    let sec = 0;
    for (const x of parts) sec = sec * 60 + x;
    ms += (Number(days) * 86400 + sec) * 1000;
  }
  return ms;
}

// oha with the server's CPU time per request (µs) added.
async function ohaCpu(pgid, target, opts, run = oha) {
  const before = cpuTreeMs(pgid);
  const res = await run(target, opts);
  const cpuMs = cpuTreeMs(pgid) - before;
  return { ...res, cpuMs: Math.round(cpuMs), cpuUsPerReq: Math.round((cpuMs * 1000 * 100) / res.requests) / 100 };
}

async function portFree() {
  for (let i = 0; i < 75; i++) {
    const busy = await new Promise((r) => {
      const s = net.connect({ port: PORT, host: "127.0.0.1" });
      s.once("connect", () => (s.destroy(), r(true)));
      s.once("error", () => r(false));
    });
    if (!busy) return;
    await sleep(200);
  }
  throw new Error(`port ${PORT} still in use`);
}

// The session cookie (--v018 session): every request carries it, oha's too.
let cookie = null;
function get(agent, urlPath) {
  return new Promise((resolve, reject) => {
    const t0 = now();
    const headers = cookie ? { cookie } : {};
    const req = http.get({ host: "127.0.0.1", port: PORT, path: urlPath, agent, headers }, (res) => {
      const ttfb = now() - t0;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, ttfb, total: now() - t0, body, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 100) / 100;
};

// Async, so the RSS sampler keeps running while oha does.
// `posts: true` reads the 90 post URLs from urlFile (oha picks one per request).
async function oha(target, { seconds, posts: fromFile }) {
  const args = ["--no-tui", "--output-format", "json", "-c", "50", "-z", `${seconds}s`];
  if (cookie) args.push("-H", `cookie: ${cookie}`);
  if (fromFile) args.push("--urls-from-file", urlFile);
  else args.push(target);
  const { status, stdout, stderr } = await new Promise((resolve) => {
    const p = spawn("oha", args);
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("exit", (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
  if (status !== 0) throw new Error(`oha failed: ${stderr}`);
  const j = JSON.parse(stdout);
  const codes = j.statusCodeDistribution ?? {};
  const ok = Object.entries(codes).reduce((n, [c, k]) => n + (c.startsWith("2") ? k : 0), 0);
  const all = Object.values(codes).reduce((n, k) => n + k, 0);
  const lat = j.latencyPercentiles ?? {};
  // Requests cut off at the deadline are expected; any other error means the numbers are wrong.
  const errors = Object.entries(j.errorDistribution ?? {})
    .filter(([e]) => e !== "aborted due to deadline")
    .reduce((n, [, k]) => n + k, 0);
  if (!all || ok / (all + errors) < 0.99 || lat.p50 == null) {
    throw new Error(`oha: ${ok} ok of ${all + errors} (${JSON.stringify(j.errorDistribution)}, ${JSON.stringify(codes)})`);
  }
  return {
    // Successful responses per second; failed ones are not throughput.
    rps: Math.round(ok / j.summary.total),
    p50: Math.round(lat.p50 * 100000) / 100,
    p99: Math.round(lat.p99 * 100000) / 100,
    non2xx: all - ok,
    errors,
    requests: ok,
  };
}

// Runs oha while sampling the tree's RSS; returns oha's result and the peak RSS.
async function ohaWithPeak(pgid, url, opts) {
  let peak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, rssTreeMB(pgid));
      await sleep(100);
    }
  })();
  const res = await oha(url, opts);
  sampling = false;
  await sampler;
  return { ...res, peakMB: peak };
}

console.log(`${label}: ${fw.label} ${version} · ${pages} pages · ${islands} islands · ${RUNS} runs · ${machine} · ${commit}`);
generate(fwName, { pages, islands, mode: "server", isr, v018 });
for (const c of fw.caches) spawnSync("rm", ["-rf", path.join(dir, c)]);
const build = spawnSync(bin, fw.serverBuild, { cwd: dir, env: { ...env, NODE_ENV: "production" }, encoding: "utf8", maxBuffer: 256 << 20 });
if (build.status !== 0) {
  console.error(`${build.stdout}${build.stderr}`.slice(-4000));
  process.exit(1);
}

for (let run = 1; run <= RUNS; run++) {
  await portFree();
  const [cmd, args] = SERVERS[fwName].cmd(bin);
  const t0 = now();
  const child = spawn(cmd, args, { cwd: dir, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const pgid = child.pid;
  try {
    let startMs = null;
    while (now() - t0 < 60000) {
      try {
        const r = await get(undefined, HOME_PATH);
        if (r.status === 200 && r.body.includes(MARK_HOME)) {
          startMs = Math.round(now() - t0);
          break;
        }
      } catch {}
      await sleep(20);
    }
    if (startMs == null) throw new Error(`${fw.label} server did not start:\n${stderr.slice(-2000)}`);
    if (fixedCookie) cookie = fixedCookie;
    else if (v018.session && sendSessionCookie) {
      cookie = null;
      const s = await get(undefined, `${BASE}/session-start`);
      const set = [].concat(s.headers["set-cookie"] ?? []).find((c) => c.startsWith("bench_session="));
      if (s.status !== 200 || !set) throw new Error(`${fw.label}: /session-start set no session cookie (${s.status})`);
      cookie = set.split(";")[0];
    }
    const check = await get(undefined, `${BASE}/posts/${pool[0]}`);
    if (check.status !== 200 || !check.body.includes(MARK_POST)) throw new Error(`${fw.label}: post page did not render (${check.status})`);
    if (v018.rules && check.headers["x-bench-rule"] !== "post") throw new Error(`${fw.label}: the headers rule did not apply to the post page`);
    const api = await get(undefined, API_PATH);
    let hits = null;
    try {
      hits = JSON.parse(api.body);
    } catch {}
    if (api.status !== 200 || !Array.isArray(hits) || !hits.length) throw new Error(`${fw.label}: ${API_PATH} did not answer with matches`);

    // Warm-up at the measured load, so JIT and caches settle before anything is recorded.
    await oha(null, { seconds: 3, posts: true });
    await sleep(1000);
    const idleMB = rssTreeMB(pgid);

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const ttfb = [];
    const total = [];
    for (let i = 0; i < 300; i++) {
      const r = await get(agent, `${BASE}/posts/${pool[i % pool.length]}`);
      if (r.status !== 200) throw new Error(`${fw.label}: status ${r.status} in the latency loop`);
      ttfb.push(r.ttfb);
      total.push(r.total);
    }
    agent.destroy();
    const latency = { ttfbP50: pct(ttfb, 0.5), ttfbP99: pct(ttfb, 0.99), totalP50: pct(total, 0.5), totalP99: pct(total, 0.99) };

    const post = await ohaCpu(pgid, null, { seconds: 10, posts: true }, (t, o) => ohaWithPeak(pgid, t, o));
    await sleep(1000);
    const home = await ohaCpu(pgid, `http://127.0.0.1:${PORT}${HOME_PATH}`, { seconds: 10 });
    await sleep(1000);
    const apiRun = await ohaCpu(pgid, `http://127.0.0.1:${PORT}${API_PATH}`, { seconds: 10 });

    const row = { run, startMs, idleMB, peakMB: post.peakMB, latency, post, home, api: apiRun };
    record(row);
    console.log(
      `  run ${run}: start ${startMs} ms · idle ${idleMB} MB · peak ${post.peakMB} MB · ttfb p50 ${latency.ttfbP50} ms (p99 ${latency.ttfbP99}) · total p50 ${latency.totalP50} ms · post ${post.rps} req/s (p99 ${post.p99} ms, non-2xx ${post.non2xx}, cpu ${post.cpuUsPerReq} µs/req) · / ${home.rps} req/s (p99 ${home.p99} ms, non-2xx ${home.non2xx}, cpu ${home.cpuUsPerReq} µs/req) · api ${apiRun.rps} req/s (p99 ${apiRun.p99} ms, cpu ${apiRun.cpuUsPerReq} µs/req)`,
    );
  } finally {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
    await sleep(1000);
  }
}
