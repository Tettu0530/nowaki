// The app's own server packages in the deploy output, on a small app generated into a temp
// directory: `zod` (env.ts and a server function), a local `file:` package (`greet`, used by a
// loader) that needs its own version of `shout` (only in its own node_modules, as pnpm lays it
// out), `shout` 2 at the top (an API route), `lazy-pkg` (only a dynamic `import()`), Node
// built-ins with and without `node:`, and an installed package nothing imports (`unused-pkg`).
//   node scripts/server-deps-e2e.mjs <mode>... [--port 4840]
// Modes:
//   node        dist/server/package.json lists every server package (registry ones by installed
//               version, the local one vendored as file:./vendor/greet); dist/ copied out of the
//               app fails to start before the install and serves the routes after an install of
//               exactly what package.json lists (an offline stand-in for `npm install --omit=dev`)
//   vercel      the function, copied out of the app (no node_modules above it), serves the routes
//   cloudflare  the worker's fetch handler, called in Node where wrangler bundles it (in place)
// Server modes listen on --port. NOWAKI_BIN overrides the binary (default target/debug/nowaki).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4840;
const modes = args.filter((a, i) => !a.startsWith("--") && (portArg < 0 || i !== portArg + 1));
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const KNOWN = ["node", "vercel", "cloudflare"];
if (!modes.length || modes.some((m) => !KNOWN.includes(m))) {
  console.error(`usage: node scripts/server-deps-e2e.mjs <${KNOWN.join("|")}>... [--port 4840]`);
  process.exit(2);
}

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pkg = (name, version, extra = {}) => JSON.stringify({ name, version, type: "module", exports: "./index.js", ...extra }) + "\n";
const FILES = {
  "package.json": JSON.stringify({
    name: "server-deps-e2e",
    private: true,
    type: "module",
    dependencies: {
      "@nowaki-dev/runtime": "workspace:*",
      preact: "^11.2.0",
      "preact-render-to-string": "^6.8.2",
      zod: "^4.6.7",
      greet: "file:./packages/greet",
      shout: "2.0.0",
      "unused-pkg": "1.0.0",
    },
  }) + "\n",
  "env.ts": `import { defineEnv } from "@nowaki-dev/runtime/env";
import { z } from "zod";
export default defineEnv({ server: { DEPS_GREETING: z.string().default("from env.ts") } });\n`,
  "lib/digest.ts": `import { createHash } from "node:crypto";
import { existsSync } from "fs";
import { join } from "path/posix";
export const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8) + (existsSync(join("/", "nope-x")) ? "!" : "");\n`,
  "routes/index.tsx": `import { greet } from "greet";
import { env } from "@nowaki-dev/runtime/env/server";
import { digest } from "../lib/digest.ts";
import Hello from "../islands/Hello.tsx";
export const loader = () => ({ msg: greet("loader"), d: digest("x"), e: env.DEPS_GREETING });
export default function Home({ data }) {
  return <main><p id="loader">{\`LOADER \${data.msg} \${data.d} \${data.e}\`}</p><Hello /></main>;
}\n`,
  "islands/Hello.tsx": `import { useState } from "preact/hooks";
import { double } from "../actions/double.ts";
export default function Hello() {
  const [n, setN] = useState(0);
  return <button onClick={async () => setN(await double(n + 1))}>{\`HELLO \${n}\`}</button>;
}\n`,
  "actions/double.ts": `"use server";
import { z } from "zod";
export async function double(n: unknown) { return z.number().int().parse(n) * 2; }\n`,
  "routes/api/shout.ts": `import { shout, version } from "shout";
export function GET() { return { body: { text: shout("api"), version } }; }\n`,
  "routes/api/lazy.ts": `export async function GET() {
  const { lazy } = await import("lazy-pkg");
  return { body: { lazy } };
}\n`,
  // A local package with its own copy of shout 1 (as pnpm leaves it: only in its own node_modules).
  "packages/greet/package.json": pkg("greet", "0.3.0", { dependencies: { shout: "1.0.0" } }),
  "packages/greet/index.js": `import { version } from "shout";\nexport const greet = (n) => \`hello \${n} (shout v\${version})\`;\n`,
  "packages/greet/node_modules/shout/package.json": pkg("shout", "1.0.0"),
  "packages/greet/node_modules/shout/index.js": `export const version = "1";\nexport const shout = (s) => s + "?";\n`,
  // Stand-ins for registry packages.
  "node_modules/shout/package.json": pkg("shout", "2.0.0"),
  "node_modules/shout/index.js": `export const version = "2";\nexport const shout = (s) => s.toUpperCase() + "!";\n`,
  "node_modules/lazy-pkg/package.json": pkg("lazy-pkg", "1.4.0"),
  "node_modules/lazy-pkg/index.js": `export const lazy = "LAZY";\n`,
  "node_modules/unused-pkg/package.json": pkg("unused-pkg", "1.0.0"),
  "node_modules/unused-pkg/index.js": `export default 1;\n`,
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-server-deps-e2e-"));
const children = new Set();
const cleanup = () => {
  for (const c of children) c.kill("SIGKILL");
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const app = path.join(tmp, "app");
for (const [file, text] of Object.entries(FILES)) {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  writeFileSync(path.join(app, file), text);
}
linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(app, "node_modules"));
// `file:./packages/greet` as npm and pnpm install it: a link to the package's own directory.
symlinkSync(path.join(app, "packages/greet"), path.join(app, "node_modules/greet"), "junction");
const zodVersion = JSON.parse(readFileSync(path.join(app, "node_modules/zod/package.json"), "utf8")).version;

// Each package is linked to its real directory by an absolute junction (as rules-e2e.mjs does).
function linkModules(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === ".bin" || name === ".cache") continue;
    const src = path.join(from, name);
    if (name.startsWith("@") && statSync(src).isDirectory() && !lstatSync(src).isSymbolicLink()) {
      linkModules(src, path.join(to, name));
      continue;
    }
    if (!existsSync(path.join(to, name))) symlinkSync(realpathSync(src), path.join(to, name), "junction");
  }
}

function build(adapter) {
  const r = spawnSync(BIN, ["build", app, "--adapter", adapter], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`nowaki build --adapter ${adapter} failed`);
  }
  return r.stdout + r.stderr;
}

// Node's lookup of a package from `from`: node_modules/<name> there or in a parent.
function findPackage(name, from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

async function serve(argv, cwd, port) {
  const child = spawn(process.execPath, argv, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PORT: String(port) } });
  children.add(child);
  let exited = false;
  child.on("exit", () => (exited = true));
  for (let i = 0; i < 80 && !exited; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/__nowaki/health" }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return () => (child.kill(), children.delete(child));
    await sleep(250);
  }
  throw new Error(`node ${argv.join(" ")} did not listen on ${port}`);
}

const httpClient = (port) => (p, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.end(body);
  });

const fnId = () => {
  const fns = JSON.parse(readFileSync(path.join(app, "dist/server/functions.json"), "utf8"));
  return Object.keys(fns).find((id) => fns[id].export === "double");
};

// The routes that load each server package.
async function routeChecks(label, req, id) {
  const t = (s) => `${label}: ${s}`;
  let r = await req("/");
  check(t("a loader uses the local package (and its own shout 1), node:crypto, fs and env.ts (zod)"), r.status === 200 && /LOADER hello loader \(shout v1\) [0-9a-f]{8} from env\.ts/.test(r.body), `${r.status} ${r.body.slice(0, 300)}`);
  r = await req("/api/shout");
  check(t("an API route uses shout 2"), r.status === 200 && r.body.includes('"text":"API!"') && r.body.includes('"version":"2"'), `${r.status} ${r.body.slice(0, 200)}`);
  r = await req("/api/lazy");
  check(t("a dynamic import() loads its package"), r.status === 200 && r.body.includes('"lazy":"LAZY"'), `${r.status} ${r.body.slice(0, 200)}`);
  r = await req("/__nowaki/fn", { method: "POST", headers: { "content-type": "application/json", "x-nowaki-rpc": "1" }, body: JSON.stringify({ id, args: [21] }) });
  check(t("a server function uses zod"), r.status === 200 && r.body.includes("42"), `${id} ${r.status} ${r.body.slice(0, 200)}`);
}

// The packages the server build found.
function depsChecks() {
  const deps = JSON.parse(readFileSync(path.join(app, "dist/server/server-deps.json"), "utf8"));
  for (const name of ["zod", "greet", "shout", "lazy-pkg", "@nowaki-dev/runtime", "preact"]) {
    check(`server-deps.json lists ${name}`, deps.includes(name), deps.join());
  }
  for (const name of ["unused-pkg", "fs", "path", "node:crypto", "crypto"]) {
    check(`server-deps.json leaves out ${name}`, !deps.includes(name), deps.join());
  }
}

try {
  for (const mode of modes) {
    if (mode === "node") {
      build("node");
      depsChecks();
      const pj = JSON.parse(readFileSync(path.join(app, "dist/server/package.json"), "utf8"));
      const deps = pj.dependencies;
      check("node: zod at its installed version", deps.zod === zodVersion, JSON.stringify(deps));
      check("node: shout at its installed version", deps.shout === "2.0.0", JSON.stringify(deps));
      check("node: lazy-pkg (not declared) at its installed version", deps["lazy-pkg"] === "1.4.0", JSON.stringify(deps));
      check("node: the local package is vendored", deps.greet === "file:./vendor/greet" && existsSync(path.join(app, "dist/server/vendor/greet/index.js")), JSON.stringify(deps));
      check("node: the vendored package has no node_modules", !existsSync(path.join(app, "dist/server/vendor/greet/node_modules")));
      check("node: nothing the server doesn't import", !("unused-pkg" in deps), JSON.stringify(deps));
      check("node: the runtime packages are listed", ["@nowaki-dev/runtime", "preact", "preact-render-to-string"].every((n) => n in deps), JSON.stringify(deps));

      // dist/ deployed elsewhere: no node_modules anywhere above it.
      const out = path.join(tmp, "node-deploy");
      cpSync(path.join(app, "dist"), path.join(out, "dist"), { recursive: true });
      const serverDir = path.join(out, "dist/server");
      const before = spawnSync(process.execPath, ["index.mjs"], { cwd: serverDir, encoding: "utf8", timeout: 15000, env: { ...process.env, PORT: String(PORT) } });
      check("node: copied out of the app, the server can't start before the install", before.status !== 0 && /Cannot find package/.test(before.stderr), `${before.status} ${before.stderr.slice(0, 300)}`);
      install(serverDir, deps);
      const stop = await serve(["index.mjs"], serverDir, PORT);
      await routeChecks("node (dist/ outside the app)", httpClient(PORT), fnId());
      stop();
    } else if (mode === "vercel") {
      build("vercel");
      depsChecks();
      // The function as Vercel runs it: its own directory and nothing above.
      const func = path.join(tmp, "vercel-deploy/index.func");
      cpSync(path.join(app, ".vercel/output/functions/index.func"), func, { recursive: true });
      const nm = path.join(func, "node_modules");
      const version = (dir) => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
      check("vercel: zod is in the function", existsSync(path.join(nm, "zod/package.json")));
      check("vercel: the local package is in the function", existsSync(path.join(nm, "greet/index.js")));
      check("vercel: shout 2 at the top", existsSync(path.join(nm, "shout")) && version(path.join(nm, "shout")) === "2.0.0");
      check("vercel: shout 1 under the package that needs it", existsSync(path.join(nm, "greet/node_modules/shout")) && version(path.join(nm, "greet/node_modules/shout")) === "1.0.0");
      check("vercel: lazy-pkg is in the function", existsSync(path.join(nm, "lazy-pkg/index.js")));
      check("vercel: nothing the server doesn't import", !existsSync(path.join(nm, "unused-pkg")));
      check("vercel: no nested preact under the runtime", !existsSync(path.join(nm, "@nowaki-dev/runtime/node_modules")));
      const stop = await serve(["-e", `import("./index.mjs").then((m) => require("http").createServer(m.default).listen(${PORT}, "127.0.0.1"))`], func, PORT);
      await routeChecks("vercel (function outside the app)", httpClient(PORT), fnId());
      stop();
    } else if (mode === "cloudflare") {
      build("cloudflare");
      depsChecks();
      // wrangler bundles dist/worker/index.js from where it is, resolving packages from the app's
      // node_modules: the same lookup as importing it here.
      const worker = (await import(pathToFileURL(path.join(app, "dist/worker/index.js")).href)).default;
      const env = { ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
      const req = async (p, init = {}) => {
        const r = await worker.fetch(new Request("https://app.example" + p, init), env, { waitUntil() {} });
        return { status: r.status, body: await r.text() };
      };
      await routeChecks("cloudflare (worker in place)", req, fnId());
    }
  }
} catch (e) {
  console.error(e);
  failed++;
}

// An offline stand-in for `npm install --omit=dev` in `dir`: links exactly the packages its
// package.json lists, a registry one from the app's node_modules (its version checked against an
// exact spec), a `file:` one to its path, with that package's own dependencies installed under it.
function install(dir, deps, from = app) {
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  for (const [name, spec] of Object.entries(deps)) {
    const to = path.join(dir, "node_modules", name);
    mkdirSync(path.dirname(to), { recursive: true });
    if (spec.startsWith("file:")) {
      const target = path.resolve(dir, spec.slice("file:".length));
      symlinkSync(target, to, "junction");
      const own = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8")).dependencies ?? {};
      // The registry would serve them; here they come from where the original package has them.
      install(target, own, realpathSync(findPackage(name, app)));
      continue;
    }
    const src = findPackage(name, from);
    if (!src) throw new Error(`install: ${name} isn't installed in the app`);
    const version = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8")).version;
    if (/^\d/.test(spec) && spec !== version) throw new Error(`install: ${name}@${spec} wanted, ${version} installed`);
    symlinkSync(realpathSync(src), to, "junction");
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall server-deps checks passed");
process.exit(failed ? 1 : 0);
