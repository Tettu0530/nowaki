#!/usr/bin/env node
// Release gate and helpers for .github/workflows/release.yml (see docs/RELEASING.md). Read-only:
// it never writes to the repo, the registries or git.
//
//   node scripts/release-check.mjs [check] [<vX.Y.Z | X.Y.Z>] [--new-tag] [--json] [--root <dir>]
//       Every shared-version file agrees with the version (default: the Cargo.toml workspace
//       version), CHANGELOG.md has its section, nowaki-core's version matches the `nowaki`
//       crate's pin, Cargo.lock and pnpm-lock.yaml are in sync, and the api/ snapshots are current
//       (when scripts/api-surface.mjs exists). --new-tag also fails when the tag
//       already exists locally (for the release PR). --json prints the release metadata.
//   node scripts/release-check.mjs notes <version> [--root <dir>]
//       Prints the CHANGELOG.md section for <version> (the GitHub Release body).
//   node scripts/release-check.mjs title <version> [--root <dir>]
//       Prints the GitHub Release title (`v1.0.0 "Nowaki"`, from the section heading's codename).
//   node scripts/release-check.mjs dist-tag <version> [--latest <npm latest>]
//       Prints the npm dist-tag for <version>: `next` for a prerelease, `latest` for a release
//       that is not older than the current `latest`, `v<major>-lts` for an older major.
//
// Exit code 0 = ok, 1 = check failed, 2 = usage error.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The shared version and its tag: X.Y.Z or X.Y.Z-rc.N, nothing else. */
const SHARED_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
/** Any SemVer 2.0 version without build metadata (markdoc has its own line). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** The npm platform packages the wrapper lists in optionalDependencies (scripts/build-npm.mjs). */
export const PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64"];

/** Parses a version, or null. `pre` is the prerelease identifiers (empty for a release). */
export function parseVersion(v) {
  const m = SEMVER.exec(String(v));
  if (!m) return null;
  const pre = m[4] ? m[4].split(".") : [];
  return { major: +m[1], minor: +m[2], patch: +m[3], pre, raw: String(v) };
}

/** SemVer precedence: negative, zero or positive. */
export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) return +p - +q;
    if (pNum) return -1;
    if (qNum) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** `v1.2.3` / `1.2.3` → `1.2.3`; throws on anything that is not a shared version. */
export function normalizeTag(input) {
  const v = String(input).replace(/^refs\/tags\//, "").replace(/^v/, "");
  if (!SHARED_VERSION.test(v)) {
    throw new Error(`"${input}" is not a release version: expected vX.Y.Z or vX.Y.Z-rc.N`);
  }
  return v;
}

/**
 * The npm dist-tag for `version`. `latest` is the version npm's `latest` tag points at today
 * (empty for a package that was never published).
 */
export function distTag(version, latest) {
  const v = parseVersion(version);
  if (!v) throw new Error(`"${version}" is not a SemVer version`);
  if (v.pre.length) return "next";
  const cur = latest ? parseVersion(latest) : null;
  if (!cur || compareVersions(v, cur) >= 0) return "latest";
  if (v.major < cur.major) return `v${v.major}-lts`;
  throw new Error(
    `${version} is older than the current npm latest (${latest}) on the same major; ` +
      "older minors get no releases (docs/RELEASING.md)",
  );
}

/** The CHANGELOG.md section for `version` (without its heading), or null. */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^## \\[${esc}\\](?:\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end < 0) {
    // The link reference list at the end of the file is not part of the last section.
    end = lines.findIndex((l, i) => i > start && /^\[[^\]]+\]: /.test(l));
    if (end < 0) end = lines.length;
  }
  return { heading: lines[start], body: lines.slice(start + 1, end).join("\n").trim() };
}

/** The GitHub Release title: `v1.0.0 "Nowaki"` when the heading names a codename, else `v1.0.0`. */
export function releaseTitle(heading, version) {
  const m = /·\s*("[^"]+")/.exec(heading);
  return m ? `v${version} ${m[1]}` : `v${version}`;
}

/** `[workspace.package] version` from Cargo.toml. */
function workspaceVersion(cargoToml) {
  const m = /\[workspace\.package\][^[]*?\bversion\s*=\s*"([^"]+)"/.exec(cargoToml);
  return m ? m[1] : null;
}

/** The `[package] version` of a member crate: a literal, or the workspace's. */
function crateVersion(crateToml, wsVersion) {
  const pkg = /\[package\]([^[]*)/.exec(crateToml);
  if (!pkg) return null;
  if (/^\s*version\.workspace\s*=\s*true/m.test(pkg[1])) return wsVersion;
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(pkg[1]);
  return m ? m[1] : null;
}

/** The `version` requirement of `nowaki-core` in crates/nowaki/Cargo.toml. */
function corePin(nowakiToml) {
  const m = /^\s*nowaki-core\s*=\s*\{([^}]*)\}/m.exec(nowakiToml);
  if (!m) return null;
  const v = /\bversion\s*=\s*"([^"]+)"/.exec(m[1]);
  return v ? v[1] : null;
}

/** Versions of `name` in Cargo.lock. */
function lockVersions(cargoLock, name) {
  const out = [];
  const re = /\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g;
  for (let m; (m = re.exec(cargoLock)); ) if (m[1] === name) out.push(m[2]);
  return out;
}

/**
 * `importers` of pnpm-lock.yaml (v9) as { [dir]: { [dep]: specifier } }. A small line parser:
 * importer keys sit at two spaces, sections at four, dependency names at six, `specifier:` at eight.
 */
export function pnpmImporters(lock) {
  const out = {};
  let inImporters = false;
  let dir = null;
  let dep = null;
  for (const line of lock.split("\n")) {
    if (/^\S/.test(line)) {
      inImporters = line.startsWith("importers:");
      continue;
    }
    if (!inImporters) continue;
    let m;
    if ((m = /^ {2}([^ ].*?):(?: \{\})?$/.exec(line))) {
      dir = unquote(m[1]);
      out[dir] = {};
    } else if ((m = /^ {6}([^ ].*?):$/.exec(line)) && dir) {
      dep = unquote(m[1]);
    } else if ((m = /^ {8}specifier: (.*)$/.exec(line)) && dir && dep) {
      out[dir][dep] = unquote(m[1]);
    }
  }
  return out;
}

function unquote(s) {
  return s.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
}

/** A dependency range that names exactly `version` (`^v`, `~v`, `=v` or `v`). */
function rangeNames(range, version) {
  return typeof range === "string" && range.replace(/^[\^~=]/, "") === version;
}

function readJson(root, rel) {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
}

/**
 * Checks the repo at `root` against `version` (null: the Cargo.toml workspace version).
 * Returns { version, errors, warnings, meta } and never throws for a check that fails.
 */
export function check(root, version, { newTag = false } = {}) {
  const errors = [];
  const warnings = [];
  const read = (rel) => readFileSync(path.join(root, rel), "utf8");

  const cargoToml = read("Cargo.toml");
  const ws = workspaceVersion(cargoToml);
  if (!ws) errors.push("Cargo.toml: no [workspace.package] version");
  const want = version ?? ws;
  if (!want || !SHARED_VERSION.test(want)) {
    errors.push(`"${want}" is not a release version (X.Y.Z or X.Y.Z-rc.N)`);
    return { version: want, errors, warnings, meta: null };
  }
  const same = (got, where) => {
    if (got !== want) errors.push(`${where} is ${got === undefined || got === null ? "missing" : `"${got}"`}, expected "${want}"`);
  };

  // Rust: the workspace version is the `nowaki` crate's (and the npm CLI's, via build-npm.mjs).
  same(ws, "Cargo.toml [workspace.package] version");
  const nowakiToml = read("crates/nowaki/Cargo.toml");
  same(crateVersion(nowakiToml, ws), "crates/nowaki/Cargo.toml version");

  // nowaki-core may be on its own line; what matters is that the pin names it exactly.
  const core = crateVersion(read("crates/nowaki-core/Cargo.toml"), ws);
  const pin = corePin(nowakiToml);
  if (!core || !parseVersion(core)) errors.push(`crates/nowaki-core/Cargo.toml version "${core}" is not SemVer`);
  if (!pin) {
    errors.push("crates/nowaki/Cargo.toml: the nowaki-core dependency has no version");
  } else if (pin.replace(/^[=^~]/, "") !== core) {
    errors.push(`crates/nowaki/Cargo.toml pins nowaki-core "${pin}", but nowaki-core is ${core}`);
  } else if (!pin.startsWith("=")) {
    warnings.push(
      `crates/nowaki/Cargo.toml pins nowaki-core "${pin}"; use "=${core}" so \`cargo install nowaki\` ` +
        "cannot pick a newer nowaki-core",
    );
  }

  if (existsSync(path.join(root, "Cargo.lock"))) {
    const lock = read("Cargo.lock");
    for (const [name, v] of [["nowaki", want], ["nowaki-core", core]]) {
      const got = lockVersions(lock, name);
      if (!got.includes(v)) errors.push(`Cargo.lock has ${name} ${got.join(", ") || "(none)"}, expected ${v} (run cargo build)`);
    }
  } else {
    errors.push("Cargo.lock is missing");
  }

  // npm packages on the shared version.
  const cli = readJson(root, "packages/nowaki-cli/package.json");
  same(cli.version, "packages/nowaki-cli/package.json version");
  for (const key of PLATFORM_KEYS) {
    same(cli.optionalDependencies?.[`@nowaki-dev/cli-${key}`], `packages/nowaki-cli optionalDependencies @nowaki-dev/cli-${key}`);
  }
  const runtime = readJson(root, "packages/nowaki-runtime/package.json");
  same(runtime.version, "packages/nowaki-runtime/package.json version");
  const createNowaki = readJson(root, "packages/create-nowaki/package.json");
  same(createNowaki.version, "packages/create-nowaki/package.json version");
  const createApp = readJson(root, "packages/create-nowaki-app/package.json");
  same(createApp.version, "packages/create-nowaki-app/package.json version");
  const appDep = createApp.dependencies?.["create-nowaki"];
  if (!rangeNames(appDep, want)) errors.push(`packages/create-nowaki-app depends on create-nowaki "${appDep}", expected "^${want}"`);

  // What `npm create nowaki` writes into a new app.
  const tpl = readJson(root, "packages/create-nowaki/templates/_shared/package.json");
  const tplRuntime = tpl.dependencies?.["@nowaki-dev/runtime"];
  const tplCli = tpl.devDependencies?.nowaki;
  if (!rangeNames(tplRuntime, want)) errors.push(`template dependencies @nowaki-dev/runtime is "${tplRuntime}", expected "^${want}"`);
  if (!rangeNames(tplCli, want)) errors.push(`template devDependencies nowaki is "${tplCli}", expected "^${want}"`);

  // markdoc keeps its own SemVer line.
  const markdoc = readJson(root, "packages/nowaki-markdoc/package.json");
  if (!parseVersion(markdoc.version)) errors.push(`packages/nowaki-markdoc version "${markdoc.version}" is not SemVer`);

  // pnpm-lock.yaml must match the package.json ranges (CI installs with --frozen-lockfile).
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) {
    const importers = pnpmImporters(read("pnpm-lock.yaml"));
    for (const dir of ["packages/create-nowaki-app", "packages/nowaki-runtime", "packages/create-nowaki", "packages/nowaki-markdoc"]) {
      const pkg = readJson(root, `${dir}/package.json`);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
      const locked = importers[dir];
      if (!locked) {
        errors.push(`pnpm-lock.yaml has no importer ${dir} (run pnpm install)`);
        continue;
      }
      for (const [name, range] of Object.entries(deps)) {
        if (locked[name] !== range) {
          errors.push(`pnpm-lock.yaml ${dir} ${name} is "${locked[name] ?? "missing"}", package.json says "${range}" (run pnpm install)`);
        }
      }
    }
  } else {
    errors.push("pnpm-lock.yaml is missing");
  }

  // The release notes.
  const section = changelogSection(read("CHANGELOG.md"), want);
  if (!section) errors.push(`CHANGELOG.md has no "## [${want}]" section`);
  else if (!section.body) errors.push(`CHANGELOG.md "## [${want}]" section is empty`);

  // The public-surface snapshots (api/), once scripts/api-surface.mjs exists.
  // It needs the workspace's `typescript`; without node_modules it is skipped here (CI's
  // api-surface job checks every PR, and release tags must be on main).
  if (existsSync(path.join(root, "scripts/api-surface.mjs")) && !existsSync(path.join(root, "node_modules/typescript"))) {
    warnings.push("api/ snapshots not checked: install dependencies first (pnpm install)");
  } else if (existsSync(path.join(root, "scripts/api-surface.mjs"))) {
    try {
      execFileSync(process.execPath, ["scripts/api-surface.mjs", "--check"], { cwd: root, stdio: "pipe" });
    } catch (e) {
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n").slice(0, 5).join(" / ");
      errors.push(`api/ snapshots are out of date (node scripts/api-surface.mjs --check): ${out}`);
    }
  }

  if (newTag) {
    let exists = false;
    try {
      execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${want}`], { cwd: root, stdio: "ignore" });
      exists = true;
    } catch {
      // not found
    }
    if (exists) errors.push(`tag v${want} already exists`);
  }

  const v = parseVersion(want);
  const meta = {
    version: want,
    tag: `v${want}`,
    prerelease: v.pre.length > 0,
    coreVersion: core,
    markdocVersion: markdoc.version,
  };
  return { version: want, errors, warnings, meta };
}

function parseArgs(argv) {
  const opts = { cmd: "check", positional: [], newTag: false, json: false, root: REPO_ROOT, latest: "" };
  const args = [...argv];
  if (["check", "notes", "title", "dist-tag"].includes(args[0])) opts.cmd = args.shift();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--new-tag") opts.newTag = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--root") opts.root = path.resolve(args[++i] ?? "");
    else if (a === "--latest") opts.latest = args[++i] ?? "";
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`release-check: ${e.message}`);
    return 2;
  }
  try {
    if (opts.cmd === "dist-tag") {
      if (!opts.positional[0]) throw new Error("usage: release-check.mjs dist-tag <version> [--latest <version>]");
      console.log(distTag(opts.positional[0].replace(/^v/, ""), opts.latest));
      return 0;
    }
    if (opts.cmd === "notes" || opts.cmd === "title") {
      if (!opts.positional[0]) throw new Error(`usage: release-check.mjs ${opts.cmd} <version>`);
      const v = normalizeTag(opts.positional[0]);
      const s = changelogSection(readFileSync(path.join(opts.root, "CHANGELOG.md"), "utf8"), v);
      if (!s) throw new Error(`CHANGELOG.md has no "## [${v}]" section`);
      console.log(opts.cmd === "notes" ? s.body : releaseTitle(s.heading, v));
      return 0;
    }
  } catch (e) {
    console.error(`release-check: ${e.message}`);
    return 1;
  }

  let version = null;
  if (opts.positional[0]) {
    try {
      version = normalizeTag(opts.positional[0]);
    } catch (e) {
      console.error(`release-check: ${e.message}`);
      return 1;
    }
  }
  const r = check(opts.root, version, { newTag: opts.newTag });
  const gha = process.env.GITHUB_ACTIONS === "true";
  for (const w of r.warnings) console.error(`${gha ? "::warning::" : "warning: "}${w}`);
  if (r.errors.length) {
    console.error(`release-check: ${r.errors.length} problem(s) for ${r.version}:`);
    for (const e of r.errors) console.error(`  - ${e}`);
    return 1;
  }
  if (opts.json) console.log(JSON.stringify(r.meta));
  else console.log(`release-check: OK, ${r.version} (nowaki-core ${r.meta.coreVersion}, markdoc ${r.meta.markdocVersion})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
