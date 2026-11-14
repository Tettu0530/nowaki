// Measures one framework at one scale. Nothing runs in parallel: one process at a time.
// Usage: node benchmarks/compare/run.mjs <framework> [--pages 10] [--islands 1] [--runs 10] [--only dev,static,server]
// Install the app first: pnpm -C benchmarks/compare/apps/<framework> install --frozen-lockfile
//
// Each measurement is repeated 1 + runs times; the first is recorded with warmup: true (cold OS
// file cache) and left out of the summary. Framework caches and build output are deleted before
// every run. Rows go to results/runs.jsonl and results/browser.jsonl.
//
//   dev     readyMs  spawn → the dev server's own ready line
//           firstMs  spawn → GET / answers 200 with the page's marker (polled; connection errors
//                    and any other response are retried), i.e. the first page actually rendered
//           postMs   then GET a post page for the first time (another route compiled on demand)
//   static  ms       the build that writes every page as HTML (Nowaki: `nowaki prerender`)
//           then, once, the output is served by lib/serve.mjs and opened in Chromium (lib/browser.mjs)
//   server  ms       the build for a Node server that renders per request (no prerendering)

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { generate, APPS } from "./gen.mjs";
import { measure } from "./lib/browser.mjs";
import { posts } from "./lib/content.mjs";
import { FRAMEWORKS, ORDER } from "./lib/frameworks.mjs";
import { serve } from "./lib/serve.mjs";
import { MARK_CONTACT, MARK_STATS } from "./lib/features.mjs";
import { MARK_HOME, MARK_POST } from "./lib/templates.mjs";

const HERE = import.meta.dirname;
const RESULTS = process.env.COMPARE_RESULTS ? path.resolve(process.env.COMPARE_RESULTS) : path.join(HERE, "results");
const DEV_PORT = 8930;
const STATIC_PORT = 8931;
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const fwName = process.argv[2];
const fw = FRAMEWORKS[fwName];
if (!fw) {
  console.error(`usage: node benchmarks/compare/run.mjs <${ORDER.join("|")}> [--pages N] [--islands N] [--runs N] [--only dev,static,server]`);
  process.exit(2);
}
const pages = Number(arg("pages", 10));
const islands = Number(arg("islands", 1));
const RUNS = Number(arg("runs", 10));
const only = new Set(arg("only", "dev,static,server").split(","));

const dir = path.join(APPS, fwName);
const bin = path.join(dir, "node_modules/.bin", fw.bin);
if (!existsSync(bin)) {
  console.error(`${fw.label} is not installed: pnpm -C benchmarks/compare/apps/${fwName} install --frozen-lockfile`);
  process.exit(2);
}
const version = JSON.parse(readFileSync(path.join(dir, "node_modules", fw.versionPkg, "package.json"), "utf8")).version;
const env = { ...process.env, ...fw.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" };
const clean = () => fw.caches.forEach((c) => rmSync(path.join(dir, c), { recursive: true, force: true }));
const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}, node ${process.version}`;
const git = (args) => spawnSync("git", args, { cwd: HERE, encoding: "utf8" }).stdout.trim();
const commit = `${git(["rev-parse", "--short", "HEAD"])}${git(["status", "--porcelain", "--", ".", ":!results"]) ? "+dirty" : ""}`;
const series = new Date().toISOString();
const oldestSlug = posts(pages).at(-1).slug;

mkdirSync(RESULTS, { recursive: true });
const record = (file, row) =>
  appendFileSync(
    path.join(RESULTS, file),
    `${JSON.stringify({ framework: fwName, label: fw.label, version, pages, islands, ...row, series, at: new Date().toISOString(), machine, commit })}\n`,
  );

// Resolves once nothing accepts connections on the port (the previous server is gone).
async function portFree(port, timeoutMs = 15000) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    const busy = await new Promise((r) => {
      const s = net.connect({ port, host: "localhost" });
      s.once("connect", () => (s.destroy(), r(true)));
      s.once("error", () => r(false));
    });
    if (!busy) return;
    await sleep(200);
  }
  throw new Error(`port ${port} still in use`);
}

// GET until 200 with `marker` in the body. Returns ms when it lands, null on timeout.
async function firstOk(url, marker, t0, timeoutMs) {
  while (now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.status === 200 && text.includes(marker)) return now() - t0;
    } catch {}
    await sleep(25);
  }
  return null;
}

async function devRun() {
  clean();
  await portFree(DEV_PORT);
  const t0 = now();
  const child = spawn(bin, fw.dev(DEV_PORT), { cwd: dir, env, detached: true });
  let readyMs = null;
  let log = "";
  const wanted = fw.ready.map((m) => m.toLowerCase());
  const onData = (buf) => {
    const text = buf.toString();
    log += text;
    if (readyMs == null && wanted.some((m) => text.toLowerCase().includes(m))) readyMs = now() - t0;
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const firstMs = await firstOk(`http://localhost:${DEV_PORT}/`, MARK_HOME, t0, 120000);
  const t1 = now();
  const postAt = firstMs == null ? null : await firstOk(`http://localhost:${DEV_PORT}/posts/${oldestSlug}`, MARK_POST, t1, 120000);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  if (fw.after) spawnSync(bin, fw.after, { cwd: dir, env, stdio: "ignore" });
  if (firstMs == null || postAt == null || readyMs == null) console.error(log.slice(-3000));
  await sleep(1500);
  return { readyMs, firstMs, postMs: postAt };
}

function buildRun(args) {
  clean();
  const t0 = now();
  const r = spawnSync(bin, args, { cwd: dir, env, encoding: "utf8", maxBuffer: 256 << 20 });
  const ms = now() - t0;
  if (r.status !== 0) {
    console.error(`${r.stdout}${r.stderr}`.slice(-4000));
    throw new Error(`${fw.label} build failed`);
  }
  return ms;
}

function countHtml(root) {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".html")) n++;
    }
  };
  walk(root);
  return n;
}

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

console.log(`${fw.label} ${version} · ${pages} pages · ${islands} islands · 1+${RUNS} runs · ${machine} · ${commit}`);

if (only.has("dev") || only.has("static")) generate(fwName, { pages, islands, mode: "static" });

if (only.has("dev")) {
  const rows = [];
  for (let i = 0; i <= RUNS; i++) {
    const r = await devRun();
    record("runs.jsonl", { metric: "dev", run: i, warmup: i === 0, ...r });
    if (i > 0) rows.push(r);
    console.log(`  dev ${i === 0 ? "warmup" : `run ${i}`}: ready ${r.readyMs} ms · first / ${r.firstMs} ms · first post ${r.postMs} ms`);
  }
  console.log(`  dev median: ready ${median(rows.map((r) => r.readyMs))} · first ${median(rows.map((r) => r.firstMs))} · post ${median(rows.map((r) => r.postMs))}`);
}

if (only.has("static")) {
  const times = [];
  for (let i = 0; i <= RUNS; i++) {
    const ms = buildRun(fw.staticBuild);
    record("runs.jsonl", { metric: "static", run: i, warmup: i === 0, ms });
    if (i > 0) times.push(ms);
    console.log(`  static build ${i === 0 ? "warmup" : `run ${i}`}: ${ms} ms`);
  }
  const out = path.join(dir, fw.staticOut);
  const html = countHtml(out);
  console.log(`  static median: ${median(times)} ms · ${html} HTML files`);
  if (html < pages + 4) throw new Error(`${fw.label}: expected at least ${pages + 4} HTML files, got ${html}`);
  const server = await serve(out, STATIC_PORT);
  try {
    // [page, url, marker, islands expected on it]; the theme toggle is on every page.
    for (const [page, url, marker, expected] of [
      ["/", "/", MARK_HOME, islands + 1],
      ["post", `/posts/${oldestSlug}`, MARK_POST, 1],
      ["/posts", "/posts", null, 2],
      ["/stats", "/stats", MARK_STATS, 2],
      ["/contact", "/contact", MARK_CONTACT, 1],
    ]) {
      const b = await measure(`http://127.0.0.1:${STATIC_PORT}${url}`, { idleJs: fw.idleJs });
      if (b.marker !== marker) throw new Error(`${fw.label}: ${url} rendered without its marker`);
      if (b.islandsOnPage !== expected || b.hydrated !== expected) {
        throw new Error(`${fw.label}: ${url} has ${b.hydrated}/${b.islandsOnPage} islands hydrated, expected ${expected}`);
      }
      record("browser.jsonl", { page, ...b });
      console.log(`  browser ${url}: JS ${b.jsKB} KB gzip (${b.jsFiles} files + ${b.inlineScripts} inline, ${b.idleKB} KB idle) · total ${b.totalKB} KB · ${b.requests} requests · hydrated ${b.hydrated}/${b.islandsOnPage}`);
    }
  } finally {
    server.close();
  }
}

if (only.has("server")) {
  generate(fwName, { pages, islands, mode: "server" });
  const times = [];
  for (let i = 0; i <= RUNS; i++) {
    const ms = buildRun(fw.serverBuild);
    record("runs.jsonl", { metric: "server", run: i, warmup: i === 0, ms });
    if (i > 0) times.push(ms);
    console.log(`  server build ${i === 0 ? "warmup" : `run ${i}`}: ${ms} ms`);
  }
  console.log(`  server median: ${median(times)} ms`);
}

clean();
