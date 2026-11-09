// Build-time generator for the Vercel adapter (runs on Node). Emits Build Output API v3 to `.vercel/output/`.
// Functions must be self-contained, so dist/server and the needed node_modules are copied into the Function.
//
// Usage: node vercel-build.mjs <serverDir> <clientDir> <outputDir> <appRoot>

import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
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

// dist/client/* → static/_nowaki/* (served by Vercel)
await cp(clientDir, path.join(staticDir, "_nowaki"), { recursive: true });
// dist/public/* → static/* (public/ files at their own path; the filesystem handler serves them
// ahead of the function, so they win over routes at the same path)
const publicIndex = await indexPublic(path.join(clientDir, "..", "public"));
for (const [url, { file }] of publicIndex) {
  const to = path.join(staticDir, ...url.split("/").filter(Boolean));
  await mkdir(path.dirname(to), { recursive: true });
  await cp(file, to);
}

await cp(serverDir, path.join(funcDir, "server"), { recursive: true });
await mkdir(path.join(funcDir, "client"), { recursive: true });
await cp(path.join(clientDir, "manifest.json"), path.join(funcDir, "client", "manifest.json"));

const nodeModules = path.join(funcDir, "node_modules");
for (const dep of ["@nowaki-dev/runtime", "preact", "preact-render-to-string"]) {
  const src = path.join(appRoot, "node_modules", dep);
  // Don't copy dependencies' nested node_modules. Doing so duplicates preact
  // (runtime's devDep), splitting hooks across instances and breaking SSR.
  // Node walks up node_modules, so it resolves to the single top-level preact.
  await cp(src, path.join(nodeModules, dep), {
    recursive: true,
    dereference: true,
    filter: (s) => !path.relative(src, s).split(path.sep).includes("node_modules"),
  });
}

const handler = `// Generated: Vercel serverless function (Node).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "@nowaki-dev/runtime/server/app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle } = await createApp({
  clientDir: path.join(here, "client"),
  serverDir: path.join(here, "server"),
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

// nowaki.config routing: redirects and headers as platform routes; the function (app.mjs) runs
// the same rules for everything (rewrites, basePath, trailingSlash, redirects left to it).
const rules = await readFile(path.join(serverDir, "routing.json"), "utf8").then(
  (t) => compileRules(JSON.parse(t)),
  () => null,
);
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
      src: "/_nowaki/(.*)",
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
  const esc = (u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paths = [...publicIndex.keys()].map((u) => esc(encodeURI(u)));
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

console.log(`[nowaki] vercel adapter: .vercel/output ready (static + index.func) → ${outputDir}`);
