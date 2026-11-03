// Unit tests for create-nowaki (path safety + template files). No network.
// Usage: node scripts/create-nowaki-test.mjs
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

for (const [label, args] of [
  ["rejects parent traversal", ["../nowaki-escape", "-y", "--no-install", "--no-git"]],
  ["rejects nested path separators", ["apps/demo", "-y", "--no-install", "--no-git"]],
  ["rejects current directory name", [".", "-y", "--no-install", "--no-git"]],
  ["rejects unknown template", ["x-app", "-t", "nope", "-y", "--no-install", "--no-git"]],
]) {
  const r = run(args);
  check(label, r.status !== 0);
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
      "routes/index.tsx",
      "routes/_404.tsx",
      "routes/api/health.ts",
    ]) {
      check(`${template}: ${rel} exists`, existsSync(path.join(app, rel)));
    }
    const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
    check(`${template}: package name normalized`, pkg.name === name);
    if (template === "basics") {
      check("basics: example server function", existsSync(path.join(app, "actions/echo.ts")));
      const echo = readFileSync(path.join(app, "actions/echo.ts"), "utf8");
      check("basics: echo validates input", echo.includes('"use server"') && echo.includes("invalid message"));
    } else {
      check("minimal: no islands directory required", !existsSync(path.join(app, "islands")));
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\nCREATE-NOWAKI TEST FAILED (${failures})` : "\nCREATE-NOWAKI TEST PASSED");
process.exit(failures ? 1 : 0);
