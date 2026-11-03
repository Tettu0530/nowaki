"use strict";

// Prebuilt binaries ship as optionalDependencies; npm/pnpm installs only the one matching os/cpu/libc.

// key -> npm package name. Must match TARGETS in scripts/build-npm.mjs.
const PACKAGES = {
  "darwin-arm64": "@nowaki-dev/cli-darwin-arm64",
  "darwin-x64": "@nowaki-dev/cli-darwin-x64",
  "linux-x64-gnu": "@nowaki-dev/cli-linux-x64-gnu",
  "linux-arm64-gnu": "@nowaki-dev/cli-linux-arm64-gnu",
  "win32-x64": "@nowaki-dev/cli-win32-x64",
};

function detectLibc() {
  try {
    const report = typeof process.report.getReport === "function" ? process.report.getReport() : null;
    const runtime = report && report.header && report.header.glibcVersionRuntime;
    return runtime ? "gnu" : "musl";
  } catch {
    return "gnu";
  }
}

function platformKey() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux") {
    return `linux-${arch}-${detectLibc()}`;
  }
  return `${platform}-${arch}`;
}

function resolveBinary() {
  const key = platformKey();
  const pkg = PACKAGES[key];
  const binName = process.platform === "win32" ? "nowaki.exe" : "nowaki";

  if (!pkg) {
    const supported = Object.keys(PACKAGES).join(", ");
    throw new Error(
      `Nowaki: no prebuilt binary is available for this platform (${key}).\n` +
        `Supported: ${supported}\n` +
        `Workaround: build from source with \`cargo install nowaki\`, or ` +
        `request support at https://github.com/Tettu0530/nowaki/issues.`,
    );
  }

  try {
    // Each platform package is a plain set of files with no exports,
    // so bin/<name> resolves as a subpath (same approach as esbuild).
    return require.resolve(`${pkg}/bin/${binName}`);
  } catch {
    throw new Error(
      `Nowaki: binary package ${pkg} not found.\n` +
        `Installing optionalDependencies may have failed.\n` +
        `Try \`npm install nowaki --force\` (or reinstall with pnpm/yarn).`,
    );
  }
}

module.exports = { resolveBinary, platformKey, PACKAGES };
