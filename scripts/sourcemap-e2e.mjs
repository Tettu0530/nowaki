// Stack traces name the real source files: a generated app whose group middleware and page
// loader throw, served by `nowaki start` (the built dist/server modules and their inline source
// maps, under node --enable-source-maps) or `nowaki dev` (the dev SSR transform). The logged stack
// must point at <app>/routes/(account)/..., not at a path joined onto dist/server/routes/....
//   node scripts/sourcemap-e2e.mjs <start|dev>... [--port 4840]
// NOWAKI_BIN overrides the binary (default target/debug/nowaki).

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4840;
const modes = args.filter((a, i) => !a.startsWith("--") && (portArg < 0 || i !== portArg + 1));
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
if (!modes.length || modes.some((m) => m !== "start" && m !== "dev")) {
  console.error("usage: node scripts/sourcemap-e2e.mjs <start|dev>... [--port 4840]");
  process.exit(2);
}

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = {
  "package.json": `{ "name": "sourcemap-e2e", "private": true, "type": "module" }\n`,
  "routes/index.tsx": `export default function Home() { return <main>{"HOME"}</main>; }\n`,
  "routes/(account)/_middleware.ts": `export default function middleware(ctx: { url: URL }) {
  if (ctx.url.pathname === "/mw-boom") {
    throw new Error("MIDDLEWARE_BOOM");
  }
}
`,
  "routes/(account)/mw-boom.tsx": `export default function MwBoom() { return <main>{"MW"}</main>; }\n`,
  "routes/(account)/loader-boom.tsx": `type Data = { n: number };

export function loader(): Data {
  throw new Error("LOADER_BOOM");
}

export default function LoaderBoom({ data }: { data: Data }) { return <main>{data.n}</main>; }
`,
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-sourcemap-e2e-"));
const children = new Set();
process.on("exit", () => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});
process.on("SIGINT", () => process.exit(130));

// Same linking as rules-e2e.mjs: per-package junctions to the real directories (Windows).
function linkModules(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === ".bin" || name === ".cache") continue;
    const src = path.join(from, name);
    if (name.startsWith("@") && statSync(src).isDirectory() && !lstatSync(src).isSymbolicLink()) {
      linkModules(src, path.join(to, name));
      continue;
    }
    symlinkSync(realpathSync(src), path.join(to, name), "junction");
  }
}

const app = path.join(tmp, "app");
for (const [file, text] of Object.entries(FILES)) {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  writeFileSync(path.join(app, file), text);
}
linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(app, "node_modules"));
const realApp = realpathSync(app);

const get = (port, p) =>
  new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", () => resolve(0));
  });

async function serve(argv, port) {
  const child = spawn(BIN, argv, { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 120; i++) {
    if ((await get(port, "/")) === 200) {
      return { log: () => log, stop: () => (child.kill(), children.delete(child)) };
    }
    await sleep(250);
  }
  throw new Error(`nowaki ${argv.join(" ")} did not listen on ${port}:\n${log}`);
}

// The stack frame for `file` as Node prints it after source mapping: an absolute path (or file
// URL) with the line and column of the throw.
function frameFor(log, file, line) {
  const want = path.join(realApp, file);
  const frames = log.split(/\r?\n/).filter((l) => /^\s+at /.test(l));
  return frames.find((l) => {
    // Paths contain parentheses (route groups), so take everything up to the last :line:col.
    const loc = l.match(/^\s+at (?:\S+ \()?(.+):(\d+):\d+\)?$/);
    if (!loc) return false;
    let p = loc[1].replace(/^file:\/\//, "");
    if (process.platform === "win32") p = p.replace(/^\/([A-Za-z]:)/, "$1");
    p = decodeURIComponent(p);
    try {
      p = realpathSync(p);
    } catch {
      return false; // not a file on disk: the path is wrong
    }
    return path.normalize(p) === path.normalize(want) && Number(loc[2]) === line;
  });
}

async function run(mode, port) {
  if (mode === "start") {
    const r = spawnSync(BIN, ["build", app], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
      throw new Error("nowaki build failed");
    }
  }
  const server = await serve([mode, app, "--port", String(port)], port);
  try {
    for (const [p, file, line, marker] of [
      ["/mw-boom", "routes/(account)/_middleware.ts", 3, "MIDDLEWARE_BOOM"],
      ["/loader-boom", "routes/(account)/loader-boom.tsx", 4, "LOADER_BOOM"],
    ]) {
      const status = await get(port, p);
      for (let i = 0; i < 40 && !server.log().includes(marker); i++) await sleep(100);
      await sleep(200);
      const log = server.log();
      check(`${mode}: ${p} fails with a 500`, status === 500, String(status));
      check(`${mode}: ${p} logs the error`, log.includes(marker), log);
      check(`${mode}: the stack names ${file}:${line}`, !!frameFor(log, file, line), log.slice(log.indexOf(marker), log.indexOf(marker) + 800));
      check(`${mode}: no stack path doubles routes/ under dist/server`, !/dist[\\/]server[\\/]routes[\\/][^\n]*routes[\\/]/.test(log));
    }
  } finally {
    server.stop();
  }
}

for (const [i, mode] of modes.entries()) await run(mode, PORT + i);
if (failed) {
  console.error(`${failed} sourcemap check(s) failed`);
  process.exit(1);
}
console.log("sourcemap e2e: all checks passed");
