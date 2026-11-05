// Smoke + unit checks for packages/nowaki-cli (JS shim → native binary).
// Usage: node scripts/npm-cli-shim-test.mjs
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgRoot = path.join(ROOT, "packages/nowaki-cli");
const require = createRequire(pathToFileURL(path.join(pkgRoot, "package.json")).href);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const { shouldExecReplace } = require("./lib/launch.js");

check("win32 keeps the Node shim (spawn fallback)", shouldExecReplace("win32") === false);
if (process.platform === "win32") {
  check("win32: execve replacement disabled", shouldExecReplace() === false);
} else if (typeof process.execve === "function") {
  check("unix: execve replacement enabled on this Node", shouldExecReplace() === true);
} else {
  check("unix without execve falls back to spawnSync", shouldExecReplace() === false);
}

spawnSync("node", [path.join(ROOT, "scripts/build-npm.mjs"), "linux-x64-gnu"], {
  cwd: ROOT,
  stdio: "inherit",
});

const layout = mkdtempSync(path.join(tmpdir(), "nowaki-npm-shim-"));
mkdirSync(path.join(layout, "node_modules/nowaki"), { recursive: true });
mkdirSync(path.join(layout, "node_modules/@nowaki-dev"), { recursive: true });
cpSync(path.join(pkgRoot, "package.json"), path.join(layout, "node_modules/nowaki/package.json"));
cpSync(path.join(pkgRoot, "bin"), path.join(layout, "node_modules/nowaki/bin"), { recursive: true });
cpSync(path.join(pkgRoot, "lib"), path.join(layout, "node_modules/nowaki/lib"), { recursive: true });
cpSync(
  path.join(pkgRoot, "npm/linux-x64-gnu"),
  path.join(layout, "node_modules/@nowaki-dev/cli-linux-x64-gnu"),
  { recursive: true },
);

const shim = path.join(layout, "node_modules/nowaki/bin/nowaki.js");
const ver = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;

const versionRun = spawnSync(process.execPath, [shim, "--version"], { encoding: "utf8" });
check(
  `shim forwards --version (got ${JSON.stringify(versionRun.stdout.trim())})`,
  versionRun.status === 0 && versionRun.stdout.trim() === `nowaki ${ver}`,
);

const badFlag = spawnSync(process.execPath, [shim, "--no-such-flag"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
check("unknown flag exit code passes through (clap → 2)", badFlag.status === 2);

if (shouldExecReplace() && process.platform !== "win32") {
  const bin = path.join(layout, "node_modules/@nowaki-dev/cli-linux-x64-gnu/bin/nowaki");
  writeFileSync(bin, "#!/bin/sh\necho $$\n", "utf8");
  chmodSync(bin, 0o755);
  const pidRun = spawnSync(process.execPath, [shim], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const nodePid = String(pidRun.pid);
  const reported = pidRun.stdout.trim();
  check(
    `execve replaces the shim process (node pid ${nodePid}, stand-in binary pid ${reported})`,
    pidRun.status === 0 && reported === nodePid,
  );
} else {
  check("execve PID check skipped (spawn fallback platform)", true);
}

console.log(failures ? `\nNPM CLI SHIM TEST FAILED (${failures})` : "\nNPM CLI SHIM TEST PASSED");
process.exit(failures ? 1 : 0);
