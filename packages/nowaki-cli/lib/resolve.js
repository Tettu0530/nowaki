"use strict";

// プリビルドバイナリは optionalDependencies で配られ、npm/pnpm が os/cpu/libc に一致する1つだけを入れる。

// key -> npm パッケージ名。scripts/build-npm.mjs の TARGETS と一致させること。
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
      `Nowaki: このプラットフォーム (${key}) 向けのプリビルドバイナリはありません。\n` +
        `対応: ${supported}\n` +
        `回避策: \`cargo install nowaki\` でソースからビルドするか、` +
        `https://github.com/nowaki-dev/nowaki/issues で対応をリクエストしてください。`,
    );
  }

  try {
    // 各プラットフォームパッケージは exports を持たない素のファイルの集まりなので、
    // bin/<name> をサブパス解決できる（esbuild と同方式）。
    return require.resolve(`${pkg}/bin/${binName}`);
  } catch {
    throw new Error(
      `Nowaki: バイナリパッケージ ${pkg} が見つかりません。\n` +
        `optionalDependencies のインストールに失敗した可能性があります。\n` +
        `\`npm install nowaki --force\`（または pnpm/yarn の再インストール）をお試しください。`,
    );
  }
}

module.exports = { resolveBinary, platformKey, PACKAGES };
