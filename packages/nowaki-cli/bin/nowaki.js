#!/usr/bin/env node
"use strict";

// Runs the prebuilt Rust nowaki binary with the same args, env, and stdio.
// No postinstall: the platform package is resolved at runtime.
//
// On Unix the Node process is replaced by the binary (process.execve, Node >= 22.15 / 23.11),
// so no Node process stays resident next to `nowaki start` (about 45 MB, #91) and signals reach
// the binary directly. Elsewhere (Windows, older Node) it falls back to a child process.

const { resolveBinary } = require("../lib/resolve.js");
const { launchBinary, exitFromSpawnResult } = require("../lib/launch.js");

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

exitFromSpawnResult(launchBinary(binary, process.argv.slice(2)));
