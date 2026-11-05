#!/usr/bin/env node
"use strict";

// Runs the prebuilt Rust nowaki binary with the same args, env, and stdio.
// No postinstall: the platform package is resolved at runtime.
//
// On Unix the Node process is replaced by the binary (process.execve, Node >= 22.15 / 23.11),
// so no Node process stays resident next to `nowaki start` (about 45 MB, #91) and signals reach
// the binary directly. Elsewhere (Windows, older Node) it falls back to a child process.

const { spawnSync } = require("node:child_process");
const { resolveBinary } = require("../lib/resolve.js");

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const args = process.argv.slice(2);

if (typeof process.execve === "function" && process.platform !== "win32") {
  try {
    process.execve(binary, [binary, ...args], process.env); // does not return on success
  } catch {
    // e.g. a noexec mount: fall through to spawnSync, which reports its own error
  }
}

const result = spawnSync(binary, args, { stdio: "inherit" });

if (result.error) {
  console.error(`[nowaki] failed to launch the binary: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
