// create-nowaki without installing: scaffolds each template (and into "."), then checks the files,
// the type files and tsconfig, and that an unknown template is refused. No network.
// Usage: node scripts/create-nowaki-test.mjs (e2e-scaffold.sh runs it first)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scaffolder = path.join(ROOT, "packages/create-nowaki/index.js");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const run = (args, cwd = ROOT) =>
  spawnSync("node", [scaffolder, ...args], { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });

{
  const r = run(["x-app", "-t", "nope", "-y", "--no-install", "--no-git"]);
  check("rejects unknown template", r.status !== 0);
}

const work = mkdtempSync(path.join(tmpdir(), "nowaki-create-test-"));
try {
  for (const template of ["basics", "minimal"]) {
    const name = `app-${template}`;
    const r = run([name, "-t", template, "-y", "--no-install", "--no-git"], work);
    check(`scaffolds ${template} template`, r.status === 0);
    const app = path.join(work, name);
    for (const rel of [
      "package.json",
      "AGENTS.md",
      ".gitignore",
      ".env.example",
      "tsconfig.json",
      "nowaki-env.d.ts",
      "nowaki-jsx.d.ts",
      "routes/index.tsx",
    ]) {
      check(`${template}: ${rel} exists`, existsSync(path.join(app, rel)));
    }
    // nowaki-env.d.ts must stay a script (no top-level import / export): as a module its
    // `declare module "*?image"` wildcards stop being ambient and asset imports fail with TS2307.
    const ambient = readFileSync(path.join(app, "nowaki-env.d.ts"), "utf8");
    check(
      `${template}: nowaki-env.d.ts is not a module`,
      !/^(import|export)\b/m.test(ambient) && ambient.includes('declare module "*?image"'),
    );
    const jsx = readFileSync(path.join(app, "nowaki-jsx.d.ts"), "utf8");
    check(`${template}: nowaki-jsx.d.ts augments preact`, /^import "preact";$/m.test(jsx) && jsx.includes('declare module "preact"'));
    const tsconfig = JSON.parse(readFileSync(path.join(app, "tsconfig.json"), "utf8"));
    check(
      `${template}: tsconfig includes both type files`,
      ["nowaki-env.d.ts", "nowaki-jsx.d.ts", ".nowaki/types.d.ts"].every((f) => tsconfig.include.includes(f)),
    );
    const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
    check(`${template}: package name normalized`, pkg.name === name);
    if (template === "basics") {
      for (const rel of ["routes/_404.tsx", "routes/api/health.ts", "actions/echo.ts"]) {
        check(`basics: ${rel} exists`, existsSync(path.join(app, rel)));
      }
      const echo = readFileSync(path.join(app, "actions/echo.ts"), "utf8");
      check("basics: echo uses serverFn validation", echo.includes('"use server"') && echo.includes("serverFn("));
    } else {
      check("minimal: no islands directory", !existsSync(path.join(app, "islands")));
      check("minimal: no _404 route file", !existsSync(path.join(app, "routes/_404.tsx")));
      check("minimal: no api/health route", !existsSync(path.join(app, "routes/api/health.ts")));
    }
  }

  const dotDir = mkdtempSync(path.join(tmpdir(), "nowaki-create-dot-"));
  try {
    const r = run([".", "-t", "minimal", "-y", "--no-install", "--no-git"], dotDir);
    check("scaffolds into empty current directory (.)", r.status === 0 && existsSync(path.join(dotDir, "routes/index.tsx")));
  } finally {
    try { rmSync(dotDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
} finally {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}

console.log(failures ? `\nCREATE-NOWAKI TEST FAILED (${failures})` : "\nCREATE-NOWAKI TEST PASSED");
process.exit(failures ? 1 : 0);
