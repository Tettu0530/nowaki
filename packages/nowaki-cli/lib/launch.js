"use strict";

const { spawnSync } = require("node:child_process");

function shouldExecReplace(platform = process.platform) {
  return platform !== "win32" && typeof process.execve === "function";
}

// On success, execve does not return. On failure (e.g. noexec mount), fall back to spawnSync.
function launchBinary(binary, argv, env = process.env) {
  if (shouldExecReplace()) {
    try {
      process.execve(binary, [binary, ...argv], env);
    } catch {
      // fall through
    }
  }
  return spawnSync(binary, argv, { stdio: "inherit", env });
}

function exitFromSpawnResult(result) {
  if (result.error) {
    console.error(`[nowaki] failed to launch the binary: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { shouldExecReplace, launchBinary, exitFromSpawnResult };
