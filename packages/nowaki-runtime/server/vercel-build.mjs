// Build-time generator for the Vercel adapter (runs on Node). Emits Build Output API v3 to `.vercel/output/`.
// Functions must be self-contained, so dist/server and the needed node_modules are copied into the Function.
//
// Usage: node vercel-build.mjs <serverDir> <clientDir> <outputDir> <appRoot>

import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { missingSecurityHeaders } from "./security-headers.mjs";
import { indexPublic } from "./public-files.mjs";
import { compileRules } from "./rules.mjs";
import { vercelHeaders, vercelRedirects } from "./vercel-routes.mjs";

const [serverDir, clientDir, outputDir, appRoot] = process.argv.slice(2);
if (!serverDir || !clientDir || !outputDir || !appRoot) {
  console.error("usage: vercel-build.mjs <serverDir> <clientDir> <outputDir> <appRoot>");
  process.exit(1);
}

const funcDir = path.join(outputDir, "functions", "index.func");
const staticDir = path.join(outputDir, "static");

await rm(outputDir, { recursive: true, force: true });
await mkdir(funcDir, { recursive: true });
await mkdir(staticDir, { recursive: true });

// nowaki.config routing (dist/server/routing.json, only when there is one).
const routing = await readFile(path.join(serverDir, "routing.json"), "utf8").then(JSON.parse, () => null);
// basePath: static files go under it, where the pages reference them.
const basePath = routing?.basePath ?? "";
const baseDir = path.join(staticDir, ...basePath.split("/").filter(Boolean));

// dist/client/* → static/<basePath>/_nowaki/* (served by Vercel)
await cp(clientDir, path.join(baseDir, "_nowaki"), { recursive: true });
// dist/public/* → static/<basePath>/* (public/ files at their own path; the filesystem handler
// serves them ahead of the function, so they win over routes at the same path)
const publicIndex = await indexPublic(path.join(clientDir, "..", "public"));
for (const [url, { file }] of publicIndex) {
  const to = path.join(baseDir, ...url.split("/").filter(Boolean));
  await mkdir(path.dirname(to), { recursive: true });
  await cp(file, to);
}

await cp(serverDir, path.join(funcDir, "server"), { recursive: true });
await mkdir(path.join(funcDir, "client"), { recursive: true });
await cp(path.join(clientDir, "manifest.json"), path.join(funcDir, "client", "manifest.json"));

const nodeModules = path.join(funcDir, "node_modules");
for (const dep of ["@nowaki-dev/runtime", "preact", "preact-render-to-string"]) {
  const src = path.join(appRoot, "node_modules", dep);
  // Dependencies' nested node_modules are not copied: a second preact there (the runtime's
  // devDependency in a workspace) would split hooks across instances and break SSR. Node walks
  // up node_modules, so it resolves to the single top-level preact.
  await cp(src, path.join(nodeModules, dep), {
    recursive: true,
    dereference: true,
    filter: (s) => !path.relative(src, s).split(path.sep).includes("node_modules"),
  });
}

// revalidatePath / revalidateTag purge Vercel's CDN through @vercel/functions when the app has it
// installed: it goes into the function with its dependencies (purge-vercel.mjs loads it lazily).
const vercelFunctions = await copyWithDeps("@vercel/functions", appRoot, nodeModules);

const handler = `// Generated: Vercel serverless function (Node).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "@nowaki-dev/runtime/server/app.mjs";
import { vercelCdn } from "@nowaki-dev/runtime/server/purge-vercel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle } = await createApp({
  clientDir: path.join(here, "client"),
  serverDir: path.join(here, "server"),
  // ISR pages carry Vercel-Cache-Tag; revalidate*() deletes those tags (@vercel/functions).
  cdn: vercelCdn(),
});
export default handle;
`;
await writeFile(path.join(funcDir, "index.mjs"), handler);

// launcher=Nodejs accepts a (req,res) handler.
await writeFile(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs" }, null, 2) +
    "\n",
);

// nowaki.config routing: redirects and headers as platform routes (vercel-routes.mjs); the
// function (app.mjs) runs the full rules for whatever reaches it (rewrites, basePath,
// trailingSlash, and the redirects the routes leave to it).
const rules = routing ? compileRules(routing) : null;
// A rewrite to a public/ file is answered by the function, which has no public/ of its own: copy
// those files into it (its default public dir, next to client/).
for (const rule of rules?.rewrites.rules ?? []) {
  const segs = rule.dest.segs;
  if (segs.every((s) => s.lit !== undefined)) {
    let url;
    try {
      url = "/" + segs.map((s) => decodeURIComponent(s.lit)).join("/");
    } catch {
      continue;
    }
    const file = publicIndex.get(url)?.file;
    if (!file) continue;
    const to = path.join(funcDir, "public", ...url.split("/").filter(Boolean));
    await mkdir(path.dirname(to), { recursive: true });
    await cp(file, to);
  } else {
    const prefix = "/" + segs.slice(0, segs.findIndex((s) => s.lit === undefined)).map((s) => s.lit).join("/");
    if ([...publicIndex.keys()].some((u) => u.startsWith(prefix === "/" ? "/" : prefix + "/"))) {
      console.warn(`[nowaki] vercel adapter: a rewrite to ${prefix}/[...] can't reach public/ files there (only a fixed destination can); routes are still served`);
    }
  }
}
const config = {
  version: 3,
  routes: [
    {
      // Static files skip the function, so they get the default security headers here; pages get
      // them from app.mjs inside the function.
      src: `^${escapeRe(basePath)}/_nowaki/(.*)`,
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        ...Object.fromEntries(missingSecurityHeaders(() => false)),
      },
      continue: true,
    },
    // public/ files skip the function too; same headers, but revalidated (names aren't hashed).
    ...publicRoutes(),
    // After the security headers, so a rule's value for the same name wins.
    ...vercelHeaders(rules),
    ...vercelRedirects(rules),
    { handle: "filesystem" },
    { src: "/.*", dest: "/index" },
  ],
};
await writeFile(path.join(outputDir, "config.json"), JSON.stringify(config, null, 2) + "\n");

/// Routes adding the security headers to public/ files, matched by exact path (100 per route to
/// keep each pattern short).
function publicRoutes() {
  const paths = [...publicIndex.keys()].map((u) => escapeRe(encodeURI(basePath + u)));
  const out = [];
  for (let i = 0; i < paths.length; i += 100) {
    out.push({
      src: `^(?:${paths.slice(i, i + 100).join("|")})$`,
      headers: { "cache-control": "public, max-age=0, must-revalidate", ...Object.fromEntries(missingSecurityHeaders(() => false)) },
      continue: true,
    });
  }
  return out;
}

/// Copies the package `name` as the app resolves it, plus its `dependencies` (each resolved from
/// the package's real directory, so pnpm's layout works too), flat into `dest`. Returns false when
/// the app doesn't have the package. A dependency that can't be found is skipped with a warning.
async function copyWithDeps(name, fromDir, dest, seen = new Set()) {
  if (seen.has(name)) return true;
  const dir = findPackage(name, fromDir);
  if (!dir) return false;
  seen.add(name);
  const real = realpathSync(dir);
  await cp(real, path.join(dest, name), {
    recursive: true,
    dereference: true,
    filter: (s) => !path.relative(real, s).split(path.sep).includes("node_modules"),
  });
  const pkg = JSON.parse(await readFile(path.join(real, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!(await copyWithDeps(dep, real, dest, seen))) console.warn(`[nowaki] vercel adapter: ${name} needs ${dep}, which isn't installed`);
  }
  return true;
}

// Node's lookup: `node_modules/<name>` in `from` or any parent directory.
function findPackage(name, from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

console.log(`[nowaki] vercel adapter: .vercel/output ready (static + index.func) → ${outputDir}`);
console.log(
  vercelFunctions
    ? "[nowaki] vercel adapter: @vercel/functions included: revalidatePath / revalidateTag purge the CDN by tag"
    : "[nowaki] vercel adapter: no @vercel/functions in the app, so revalidatePath / revalidateTag can't purge the CDN (npm i @vercel/functions to enable)",
);
