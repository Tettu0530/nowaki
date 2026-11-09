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
const { platformKey, PACKAGES } = require("./lib/resolve.js");

check("win32 keeps the Node shim (spawn fallback)", shouldExecReplace("win32") === false);
if (process.platform === "win32") {
  check("win32: execve replacement disabled", shouldExecReplace() === false);
} else if (typeof process.execve === "function") {
  check("unix: execve replacement enabled on this Node", shouldExecReplace() === true);
} else {
  check("unix without execve falls back to spawnSync", shouldExecReplace() === false);
}

const key = platformKey();
const pkg = PACKAGES[key];
if (!pkg) {
  console.log(`skip binary checks (no package for ${key})`);
  console.log(failures ? `\nNPM CLI SHIM TEST FAILED (${failures})` : "\nNPM CLI SHIM TEST PASSED");
  process.exit(failures ? 1 : 0);
}

const built = spawnSync("node", [path.join(ROOT, "scripts/build-npm.mjs"), key], {
  cwd: ROOT,
  stdio: "inherit",
});
if (built.status !== 0) {
  console.error(`build-npm.mjs ${key} failed (status ${built.status})`);
  process.exit(built.status ?? 1);
}

const layout = mkdtempSync(path.join(tmpdir(), "nowaki-npm-shim-"));
const nowakiDir = path.join(layout, "node_modules/nowaki");
const pkgDir = path.join(layout, "node_modules", pkg);
mkdirSync(nowakiDir, { recursive: true });
mkdirSync(path.dirname(pkgDir), { recursive: true });
cpSync(path.join(pkgRoot, "package.json"), path.join(nowakiDir, "package.json"));
cpSync(path.join(pkgRoot, "bin"), path.join(nowakiDir, "bin"), { recursive: true });
cpSync(path.join(pkgRoot, "lib"), path.join(nowakiDir, "lib"), { recursive: true });
cpSync(path.join(pkgRoot, "npm", key), pkgDir, { recursive: true });

const shim = path.join(nowakiDir, "bin/nowaki.js");
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

if (shouldExecReplace()) {
  const bin = path.join(pkgDir, "bin", "nowaki");
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
  console.log("skip execve PID check (spawn fallback)");
}

console.log(failures ? `\nNPM CLI SHIM TEST FAILED (${failures})` : "\nNPM CLI SHIM TEST PASSED");
process.exit(failures ? 1 : 0);
