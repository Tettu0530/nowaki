// Tests for scripts/release-check.mjs (the release gate) and scripts/ci/npm-publish-if-new.sh
// (with a fake `npm` on PATH, so nothing reaches the registry).
// Usage: node scripts/release-check-test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changelogSection,
  check,
  compareVersions,
  distTag,
  normalizeTag,
  pnpmImporters,
  releaseTitle,
} from "./release-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/release-check.mjs");

let failed = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};
const throws = (fn, re, label) => {
  try {
    fn();
    eq("no error", String(re), label);
  } catch (e) {
    eq(re.test(e.message), true, `${label} (${e.message})`);
  }
};

// --- pure helpers -------------------------------------------------------------------------

eq(normalizeTag("v1.0.0"), "1.0.0", "normalizeTag v1.0.0");
eq(normalizeTag("refs/tags/v1.0.0-rc.2"), "1.0.0-rc.2", "normalizeTag refs/tags/…-rc.2");
eq(normalizeTag("0.19.3"), "0.19.3", "normalizeTag without v");
throws(() => normalizeTag("v1.0.0-beta.1"), /not a release version/, "normalizeTag rejects -beta");
throws(() => normalizeTag("v1.0"), /not a release version/, "normalizeTag rejects X.Y");
throws(() => normalizeTag("v01.0.0"), /not a release version/, "normalizeTag rejects a leading zero");
throws(() => normalizeTag("v1.0.0-rc"), /not a release version/, "normalizeTag rejects -rc without N");

eq(compareVersions("1.0.0-rc.2", "1.0.0-rc.10") < 0, true, "rc.2 < rc.10 (numeric)");
eq(compareVersions("1.0.0-rc.9", "1.0.0") < 0, true, "rc < release");
eq(compareVersions("1.0.0", "0.19.3") > 0, true, "1.0.0 > 0.19.3");
eq(compareVersions("1.2.3", "1.2.3"), 0, "equal");

eq(distTag("1.0.0-rc.1", "0.19.3"), "next", "rc -> next");
eq(distTag("1.0.0-rc.1", ""), "next", "rc, never published -> next");
eq(distTag("1.0.0", "0.19.3"), "latest", "release newer than latest -> latest");
eq(distTag("0.1.0", ""), "latest", "first publish -> latest");
eq(distTag("1.0.0", "1.0.0-rc.3"), "latest", "1.0.0 over an rc latest -> latest");
eq(distTag("1.4.2", "2.0.1"), "v1-lts", "older major -> v1-lts");
eq(distTag("1.0.0", "1.0.0"), "latest", "same version (re-run) -> latest");
throws(() => distTag("1.2.1", "1.3.0"), /older than the current npm latest/, "older minor on the same major is refused");

{
  const cl = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0-rc.1] — 2026-12-01 · rc\n\nRC notes.\n\n## [0.19.3] — x\n\nOld.\n\n[0.19.3]: https://example.com\n";
  eq(changelogSection(cl, "1.0.0-rc.1")?.body, "RC notes.", "changelogSection: middle section");
  eq(changelogSection(cl, "0.19.3")?.body, "Old.", "changelogSection: last section stops at the link list");
  eq(changelogSection(cl, "1.0.0"), null, "changelogSection: 1.0.0 is not 1.0.0-rc.1");
  eq(changelogSection(cl, "0.19"), null, "changelogSection: no prefix match");
}

eq(releaseTitle('## [0.19.3] — 2026-11-12 · "Bora": production and dev experience', "0.19.3"), 'v0.19.3 "Bora"', "releaseTitle with a codename");
eq(releaseTitle("## [0.18.2] — 2026-11-11 · patch", "0.18.2"), "v0.18.2", "releaseTitle without one");

{
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "  packages/create-nowaki-app:",
    "    dependencies:",
    "      create-nowaki:",
    "        specifier: ^1.0.0-rc.1",
    "        version: link:../create-nowaki",
    "      '@scope/x':",
    "        specifier: '>=1'",
    "        version: 1.0.0",
    "",
    "packages:",
    "",
    "  create-nowaki@1.0.0:",
    "    resolution: {integrity: sha512-x}",
  ].join("\n");
  eq(
    pnpmImporters(lock),
    { ".": {}, "packages/create-nowaki-app": { "create-nowaki": "^1.0.0-rc.1", "@scope/x": ">=1" } },
    "pnpmImporters parses importers only",
  );
}

// --- the gate on a copy of this repo's version files ----------------------------------------

const FILES = [
  "Cargo.toml",
  "Cargo.lock",
  "crates/nowaki/Cargo.toml",
  "crates/nowaki-core/Cargo.toml",
  "packages/nowaki-cli/package.json",
  "packages/nowaki-runtime/package.json",
  "packages/nowaki-markdoc/package.json",
  "packages/create-nowaki/package.json",
  "packages/create-nowaki-app/package.json",
  "packages/create-nowaki/templates/_shared/package.json",
  "pnpm-lock.yaml",
  "CHANGELOG.md",
];

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-release-check-"));
let n = 0;
function fixture() {
  const dir = path.join(tmp, `r${n++}`);
  for (const f of FILES) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    cpSync(path.join(ROOT, f), path.join(dir, f));
  }
  return dir;
}
const edit = (dir, rel, fn) => writeFileSync(path.join(dir, rel), fn(readFileSync(path.join(dir, rel), "utf8")));
const editJson = (dir, rel, fn) => edit(dir, rel, (s) => JSON.stringify(fn(JSON.parse(s)), null, 2) + "\n");

/** Moves every shared-version field to `v`, nowaki-core to `core` with `pin`, as a release PR does. */
function bump(dir, v, { core = v, pin = `=${core}`, changelog = true } = {}) {
  const cur = JSON.parse(readFileSync(path.join(dir, "packages/nowaki-cli/package.json"), "utf8")).version;
  edit(dir, "Cargo.toml", (s) => s.replace(/(\[workspace\.package\]\s*\nversion = )"[^"]+"/, `$1"${v}"`));
  // nowaki-core has its own line: a literal version (the workspace one before 0.20.0).
  edit(dir, "crates/nowaki-core/Cargo.toml", (s) =>
    s.replace(/^version(?:\.workspace = true| = "[^"]+")$/m, `version = "${core}"`),
  );
  edit(dir, "crates/nowaki/Cargo.toml", (s) =>
    s.replace(/(nowaki-core = \{ path = "\.\.\/nowaki-core", version = )"[^"]+"/, `$1"${pin}"`),
  );
  edit(dir, "Cargo.lock", (s) =>
    s
      .replace(/(name = "nowaki"\nversion = )"[^"]+"/, `$1"${v}"`)
      .replace(/(name = "nowaki-core"\nversion = )"[^"]+"/, `$1"${core}"`),
  );
  editJson(dir, "packages/nowaki-cli/package.json", (p) => {
    p.version = v;
    for (const k of Object.keys(p.optionalDependencies)) p.optionalDependencies[k] = v;
    return p;
  });
  for (const rel of ["packages/nowaki-runtime/package.json", "packages/create-nowaki/package.json"]) {
    editJson(dir, rel, (p) => ({ ...p, version: v }));
  }
  editJson(dir, "packages/create-nowaki-app/package.json", (p) => {
    p.version = v;
    p.dependencies["create-nowaki"] = `^${v}`;
    return p;
  });
  editJson(dir, "packages/create-nowaki/templates/_shared/package.json", (p) => {
    p.dependencies["@nowaki-dev/runtime"] = `^${v}`;
    p.devDependencies.nowaki = `^${v}`;
    return p;
  });
  edit(dir, "pnpm-lock.yaml", (s) => s.replace(`specifier: ^${cur}`, `specifier: ^${v}`));
  // The Unreleased entries become the new section, as in a release PR.
  if (changelog) {
    edit(dir, "CHANGELOG.md", (s) =>
      s.replace(/## \[Unreleased\]\n[\s\S]*?(?=\n## \[)/, `## [Unreleased]\n\n## [${v}] — 2026-12-01 · test\n\nNotes for ${v}.\n`),
    );
  }
}

const errs = (dir, v, opts) => check(dir, v, opts).errors;
const has = (list, re) => list.some((e) => re.test(e));

{
  const d = fixture();
  eq(errs(d, null), [], "repo copy as-is passes (workspace version)");
}
{
  const d = fixture();
  bump(d, "1.0.0-rc.1", { core: "0.20.0" });
  const r = check(d, "1.0.0-rc.1");
  eq(r.errors, [], "1.0.0-rc.1 with nowaki-core 0.20.0 pinned =0.20.0 passes");
  eq(r.warnings, [], "  … and has no warning");
  eq(r.meta, { version: "1.0.0-rc.1", tag: "v1.0.0-rc.1", prerelease: true, coreVersion: "0.20.0", markdocVersion: "0.1.0" }, "  … meta");
}
{
  const d = fixture();
  bump(d, "1.0.0");
  eq(check(d, "1.0.0").meta?.prerelease, false, "1.0.0 is not a prerelease");
  eq(has(errs(d, "1.0.0-rc.1"), /expected "1\.0\.0-rc\.1"/), true, "tag v1.0.0-rc.1 against 1.0.0 files fails");
}
{
  const d = fixture();
  bump(d, "1.0.0", { core: "0.20.0", pin: "0.20.0" });
  const r = check(d, "1.0.0");
  eq(has(r.errors, /pins nowaki-core "0\.20\.0"; use "=0\.20\.0"/), true, "caret pin of the right core version fails: the pin must be exact");
}
{
  const d = fixture();
  bump(d, "0.20.0", { core: "0.19.3" });
  const r = check(d, "0.20.0");
  eq(r.errors, [], "0.20.0 with nowaki-core left at 0.19.3 (its own line) passes");
  eq(r.meta?.coreVersion, "0.19.3", "  … meta names nowaki-core's own version");
}
{
  const d = fixture();
  bump(d, "1.0.0", { core: "0.20.0", pin: "=0.19.3" });
  eq(has(errs(d, "1.0.0"), /pins nowaki-core "=0\.19\.3", but nowaki-core is 0\.20\.0/), true, "pin disagreeing with nowaki-core fails");
}
{
  const d = fixture();
  bump(d, "1.0.0", { core: "0.20.0" });
  edit(d, "Cargo.lock", (s) => s.replace(/(name = "nowaki-core"\nversion = )"[^"]+"/, `$1"0.19.3"`));
  eq(has(errs(d, "1.0.0"), /Cargo\.lock has nowaki-core 0\.19\.3, expected 0\.20\.0/), true, "stale Cargo.lock fails");
}
{
  const d = fixture();
  bump(d, "1.0.0", { changelog: false });
  eq(has(errs(d, "1.0.0"), /CHANGELOG\.md has no "## \[1\.0\.0\]" section/), true, "missing CHANGELOG section fails");
}
{
  const d = fixture();
  bump(d, "1.0.0");
  editJson(d, "packages/nowaki-runtime/package.json", (p) => ({ ...p, version: "0.19.3" }));
  eq(errs(d, "1.0.0"), ['packages/nowaki-runtime/package.json version is "0.19.3", expected "1.0.0"'], "runtime left behind fails (only that)");
}
{
  const d = fixture();
  bump(d, "1.0.0");
  editJson(d, "packages/nowaki-cli/package.json", (p) => {
    p.optionalDependencies["@nowaki-dev/cli-win32-x64"] = "0.19.3";
    return p;
  });
  eq(has(errs(d, "1.0.0"), /@nowaki-dev\/cli-win32-x64 is "0\.19\.3"/), true, "one platform optionalDependency behind fails");
}
{
  const d = fixture();
  bump(d, "1.0.0");
  editJson(d, "packages/create-nowaki/templates/_shared/package.json", (p) => {
    p.devDependencies.nowaki = "^0.19.3";
    return p;
  });
  eq(has(errs(d, "1.0.0"), /template devDependencies nowaki is "\^0\.19\.3"/), true, "template CLI pin behind fails");
}
{
  const d = fixture();
  bump(d, "1.0.0");
  edit(d, "pnpm-lock.yaml", (s) => s.replace("specifier: ^1.0.0", "specifier: ^0.19.3"));
  eq(has(errs(d, "1.0.0"), /pnpm-lock\.yaml packages\/create-nowaki-app create-nowaki/), true, "stale pnpm-lock.yaml fails");
}
{
  const d = fixture();
  bump(d, "1.0.0");
  editJson(d, "packages/nowaki-markdoc/package.json", (p) => ({ ...p, version: "1.0" }));
  eq(has(errs(d, "1.0.0"), /nowaki-markdoc version "1\.0" is not SemVer/), true, "markdoc must be SemVer");
  editJson(d, "packages/nowaki-markdoc/package.json", (p) => ({ ...p, version: "1.0.0" }));
  eq(errs(d, "1.0.0"), [], "markdoc on its own version passes");
}
{
  const d = fixture();
  eq(has(errs(d, "1.0.0-beta.1"), /not a release version/), true, "a -beta version is refused");
}
{
  const d = fixture();
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: d });
  eq(errs(d, null, { newTag: true }), [], "--new-tag passes before tagging");
  execFileSync("git", ["tag", `v${check(d, null).version}`], { cwd: d });
  eq(has(errs(d, null, { newTag: true }), /already exists/), true, "--new-tag fails once the tag exists");
}

// --- the CLI -------------------------------------------------------------------------------

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...opts });
{
  const d = fixture();
  bump(d, "1.0.0-rc.2", { core: "0.20.0" });
  const ok = run(["v1.0.0-rc.2", "--json", "--root", d]);
  eq(ok.status, 0, "cli: check v1.0.0-rc.2 exits 0");
  eq(JSON.parse(ok.stdout).prerelease, true, "cli: --json prerelease");
  const bad = run(["v1.0.0", "--root", d]);
  eq(bad.status, 1, "cli: wrong tag exits 1");
  eq(/problem\(s\) for 1\.0\.0/.test(bad.stderr), true, "cli: lists the problems");
  const notes = run(["notes", "v1.0.0-rc.2", "--root", d]);
  eq([notes.status, notes.stdout.trim()], [0, "Notes for 1.0.0-rc.2."], "cli: notes");
  eq(run(["title", "1.0.0-rc.2", "--root", d]).stdout.trim(), "v1.0.0-rc.2", "cli: title");
  eq(run(["title", "0.19.3"]).stdout.trim(), 'v0.19.3 "Bora"', "cli: title from this repo's CHANGELOG");
  eq(run(["notes", "v9.9.9", "--root", d]).status, 1, "cli: notes for a missing section exits 1");
  eq(run(["dist-tag", "1.0.0-rc.2", "--latest", "0.19.3"]).stdout.trim(), "next", "cli: dist-tag rc");
  eq(run(["dist-tag", "v1.0.0"]).stdout.trim(), "latest", "cli: dist-tag first release");
  eq(run(["dist-tag", "1.0.1", "--latest", "1.1.0"]).status, 1, "cli: dist-tag older minor exits 1");
  eq(run(["--bogus"]).status, 2, "cli: unknown option exits 2");
  eq(run(["vnope"]).status, 1, "cli: bad tag exits 1");
}

// --- npm-publish-if-new.sh with a fake npm ---------------------------------------------------

if (process.platform !== "win32") {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const log = path.join(tmp, "npm.log");
  // `npm view <name>@<version> version` succeeds only for versions listed in FAKE_PUBLISHED;
  // `npm view <name> dist-tags.latest` prints FAKE_LATEST.
  writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1" = view ]; then
  case "$3" in
    version) for v in $FAKE_PUBLISHED; do [ "$2" = "$v" ] && { echo ok; exit 0; }; done; exit 1 ;;
    dist-tags.latest) [ -n "$FAKE_LATEST" ] && echo "$FAKE_LATEST"; exit 0 ;;
  esac
fi
exit 0
`,
  );
  chmodSync(path.join(bin, "npm"), 0o755);
  const pkg = path.join(tmp, "pkg");
  mkdirSync(pkg);
  const publish = (version, env) => {
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@x/pkg", version }));
    writeFileSync(log, "");
    const r = spawnSync("bash", [path.join(ROOT, "scripts/ci/npm-publish-if-new.sh")], {
      cwd: pkg,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: "", NPM_DRY_RUN: "", FAKE_PUBLISHED: "", FAKE_LATEST: "", ...env },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.startsWith("view"));
    return { status: r.status, calls, out: r.stdout + r.stderr };
  };
  eq(publish("1.0.0-rc.1", { FAKE_LATEST: "0.19.3" }).calls, ["publish --access public --tag next"], "sh: rc publishes to next");
  eq(publish("1.0.0", { FAKE_LATEST: "1.0.0-rc.1", GITHUB_ACTIONS: "true" }).calls, ["publish --access public --tag latest --provenance"], "sh: release on Actions adds --provenance");
  eq(publish("1.0.0", { FAKE_PUBLISHED: "@x/pkg@1.0.0" }).calls, [], "sh: already published is skipped");
  eq(publish("1.0.0", { FAKE_PUBLISHED: "@x/pkg@1.0.0", NPM_DRY_RUN: "1" }).calls, ["pack --dry-run"], "sh: dry run of a published version packs only");
  eq(publish("1.1.0", { NPM_DRY_RUN: "1", GITHUB_ACTIONS: "true" }).calls, ["publish --access public --tag latest --dry-run"], "sh: dry run has no --provenance");
  eq(publish("1.4.0", { FAKE_LATEST: "2.0.0" }).calls, ["publish --access public --tag v1-lts"], "sh: older major goes to v1-lts");
  const refused = publish("2.0.1", { FAKE_LATEST: "2.1.0" });
  eq([refused.status !== 0, refused.calls], [true, []], "sh: older minor is refused before publishing");
}

rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nrelease-check: all ok");
