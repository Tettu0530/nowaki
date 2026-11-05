// Measures one docs-site app at one size. Nothing runs in parallel: one process at a time.
// Usage: node benchmarks/docs-site/run.mjs <nowaki|astro> [--entries 20] [--runs 5]
// Nowaki is measured from this checkout (it ships before a release): NOWAKI_BIN, or
// ./target/release/nowaki (cargo build --release -p nowaki). Install the apps first:
//   pnpm -C benchmarks/docs-site/apps/<fw> install
//
//   cold   static build with build output and every framework cache deleted first; 1 + runs
//          (the first, with a cold OS file cache, is recorded as warmup and left out)
//   warm   the same build again with the caches kept (only the output deleted); runs.
//          Nowaki caches AVIF encodes and highlighted code in node_modules/.cache/nowaki;
//          Astro keeps optimized images and the content data store in node_modules/.astro and .astro.
//   output after the last build: HTML / image / CSS / JS bytes and file counts, sitemap URLs
//   browser the output served by ../compare/lib/serve.mjs and opened in Chromium
//          (../compare/lib/browser.mjs): a Markdown entry, an MDX entry, and /docs/
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { measure } from "../compare/lib/browser.mjs";
import { serve } from "../compare/lib/serve.mjs";
import { slugOf } from "./lib/content.mjs";
import { MARK_ENTRY, MARK_LIST } from "./lib/templates.mjs";
import { APPS, generate } from "./gen.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const RESULTS = process.env.DOCS_RESULTS ? path.resolve(process.env.DOCS_RESULTS) : path.join(HERE, "results");
const PORT = 8951;
const now = () => performance.now();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const FW = {
  nowaki: {
    label: "Nowaki",
    bin: () => process.env.NOWAKI_BIN ?? path.join(ROOT, "target/release/nowaki"),
    build: ["build", ".", "--adapter", "static"],
    out: "dist/static",
    output: ["dist"],
    caches: ["node_modules/.cache/nowaki", ".nowaki"],
    version: (dir, bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^nowaki /, ""),
  },
  astro: {
    label: "Astro",
    bin: (dir) => path.join(dir, "node_modules/.bin/astro"),
    build: ["build"],
    out: "dist",
    output: ["dist"],
    caches: [".astro", "node_modules/.astro", "node_modules/.vite"],
    env: { ASTRO_TELEMETRY_DISABLED: "1" },
    version: (dir) => JSON.parse(readFileSync(path.join(dir, "node_modules/astro/package.json"), "utf8")).version,
  },
};

const fwName = process.argv[2];
const fw = FW[fwName];
if (!fw) {
  console.error("usage: node benchmarks/docs-site/run.mjs <nowaki|astro> [--entries N] [--runs N]");
  process.exit(2);
}
const n = Number(arg("entries", 20));
const RUNS = Number(arg("runs", 5));
const dir = path.join(APPS, fwName);
const bin = fw.bin(dir);
if (!existsSync(bin)) {
  console.error(`${fw.label}: ${bin} not found`);
  process.exit(2);
}
// pnpm copies the file: runtime and does not refresh the copy, so a stale one would measure
// old runtime code under the new binary.
if (fwName === "nowaki") {
  const src = path.join(ROOT, "packages/nowaki-runtime");
  const installed = realpathSync(path.join(dir, "node_modules/@nowaki-dev/runtime"));
  const list = (root) => walk(root).filter((x) => !x.path.startsWith("node_modules")).map((x) => x.path).sort();
  const stale = list(src).filter((p) => !existsSync(path.join(installed, p)) || !readFileSync(path.join(src, p)).equals(readFileSync(path.join(installed, p))));
  if (stale.length) {
    console.error(`the installed @nowaki-dev/runtime differs from packages/nowaki-runtime (${stale.slice(0, 3).join(", ")}…): rm -rf ${path.relative(ROOT, dir)}/node_modules && pnpm -C ${path.relative(ROOT, dir)} install`);
    process.exit(2);
  }
}
const version = fw.version(dir, bin);
const env = { ...process.env, ...fw.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" };
const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}, node ${process.version}`;
const git = (args) => spawnSync("git", args, { cwd: HERE, encoding: "utf8" }).stdout.trim();
const commit = `${git(["rev-parse", "--short", "HEAD"])}${git(["status", "--porcelain", "--", ".", ":!results", "../../crates", "../../packages"]) ? "+dirty" : ""}`;
const series = new Date().toISOString();
mkdirSync(RESULTS, { recursive: true });
const record = (file, row) =>
  appendFileSync(path.join(RESULTS, file), `${JSON.stringify({ framework: fwName, label: fw.label, version, entries: n, ...row, series, at: new Date().toISOString(), machine, commit })}\n`);

const rm = (list) => list.forEach((p) => rmSync(path.join(dir, p), { recursive: true, force: true }));
function build() {
  const t0 = now();
  const r = spawnSync(bin, fw.build, { cwd: dir, env, encoding: "utf8", maxBuffer: 256 << 20 });
  const ms = Math.round(now() - t0);
  if (r.status !== 0) {
    console.error(`${r.stdout}${r.stderr}`.slice(-4000));
    throw new Error(`${fw.label} build failed`);
  }
  return ms;
}

function walk(root) {
  const out = [];
  const go = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else out.push({ path: path.relative(root, p), bytes: statSync(p).size });
    }
  };
  go(root);
  return out;
}
function outputSizes(root) {
  const files = walk(root);
  const sum = (re) => {
    const f = files.filter((x) => re.test(x.path));
    return { files: f.length, KB: Math.round(f.reduce((s, x) => s + x.bytes, 0) / 102.4) / 10 };
  };
  // Page URLs only: a sitemap index's <loc>s point at other sitemaps.
  const sitemaps = files
    .filter((x) => /sitemap[^/]*\.xml$/.test(x.path))
    .map((x) => readFileSync(path.join(root, x.path), "utf8"))
    .filter((xml) => xml.includes("<urlset"));
  const urls = sitemaps.reduce((s, xml) => s + (xml.match(/<loc>/g)?.length ?? 0), 0);
  return {
    html: sum(/\.html$/),
    images: sum(/\.(avif|webp|jpe?g|png)$/),
    avif: sum(/\.avif$/),
    webp: sum(/\.webp$/),
    jpg: sum(/\.jpe?g$/),
    css: sum(/\.css$/),
    js: sum(/\.m?js$/),
    total: sum(/./),
    sitemapUrls: urls,
  };
}

console.log(`${fw.label} ${version} · ${n} entries · 1+${RUNS} cold, ${RUNS} warm · ${machine} · ${commit}`);
generate(fwName, n);

const cold = [];
for (let i = 0; i <= RUNS; i++) {
  rm([...fw.output, ...fw.caches]);
  const ms = build();
  record("runs.jsonl", { kind: "cold", run: i, warmup: i === 0, ms });
  if (i > 0) cold.push(ms);
  console.log(`  cold ${i === 0 ? "warmup" : `run ${i}`}: ${ms} ms`);
}
const warm = [];
for (let i = 1; i <= RUNS; i++) {
  rm(fw.output);
  const ms = build();
  record("runs.jsonl", { kind: "warm", run: i, warmup: false, ms });
  warm.push(ms);
  console.log(`  warm run ${i}: ${ms} ms`);
}
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
console.log(`  median: cold ${med(cold)} ms · warm ${med(warm)} ms`);

const out = path.join(dir, fw.out);
const sizes = outputSizes(out);
record("output.jsonl", sizes);
console.log(`  output: HTML ${sizes.html.KB} KB (${sizes.html.files}) · images ${sizes.images.KB} KB (${sizes.images.files}) · CSS ${sizes.css.KB} KB · JS ${sizes.js.KB} KB · sitemap ${sizes.sitemapUrls} URLs`);
if (sizes.html.files < n + 2) throw new Error(`${fw.label}: expected at least ${n + 2} HTML files, got ${sizes.html.files}`);
if (sizes.sitemapUrls < n + 2) throw new Error(`${fw.label}: sitemap has ${sizes.sitemapUrls} URLs, expected at least ${n + 2}`);

const server = await serve(out, PORT);
try {
  for (const [page, url, marker] of [
    ["md", `/docs/${slugOf(1)}/`, MARK_ENTRY],
    ["mdx", `/docs/${slugOf(5)}/`, MARK_ENTRY],
    ["list", "/docs/", MARK_LIST],
  ]) {
    const b = await measure(`http://127.0.0.1:${PORT}${url}`);
    if (b.marker !== marker) throw new Error(`${fw.label}: ${url} rendered without its marker`);
    record("browser.jsonl", { page, ...b });
    console.log(`  browser ${url}: JS ${b.jsKB} KB · total ${b.totalKB} KB · ${b.requests} requests · ${JSON.stringify(b.byTypeKB)}`);
  }
} finally {
  server.close();
}
