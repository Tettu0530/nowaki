#!/usr/bin/env node
"use strict";

// Forwards args and stdio unchanged to the prebuilt Rust nowaki binary.
// No postinstall: the platform package is resolved and exec'd at runtime.

const { spawnSync } = require("node:child_process");
const { resolveBinary } = require("../lib/resolve.js");

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`[nowaki] failed to launch the binary: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
