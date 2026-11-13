// Tests for scripts/api-surface.mjs: the snapshot format, the removal check, and the generators
// on small fixtures (a removed export, a changed signature, a new env var, a new endpoint).
// Usage: node scripts/api-surface-test.mjs

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addedEntries,
  classify,
  genEnv,
  genHttp,
  genRuntime,
  generateAll,
  parseSnapshot,
  removedEntries,
  unclassified,
  versionAtLeast,
} from "./api-surface.mjs";

let failed = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};
const throws = (fn, re, label) => {
  try {
    fn();
  } catch (e) {
    eq(re.test(String(e?.message ?? e)), true, `${label} (${e?.message ?? e})`);
    return;
  }
  eq("no error", re.toString(), label);
};

// --- format -------------------------------------------------------------------------------
const snap = `# header
[stable .]
export function a(): void;
export function b(x: string): number;  # a comment

[internal]
SECRET_THING  # somewhere.rs
`;
eq(
  parseSnapshot(snap),
  ["[stable .]\texport function a(): void;", "[stable .]\texport function b(x: string): number;", "[internal]\tSECRET_THING"],
  "parseSnapshot: entries keyed by section, comments dropped",
);
eq(parseSnapshot(snap, { onlyCovered: true }).length, 2, "parseSnapshot: onlyCovered keeps [stable ...] only");
eq(removedEntries(snap, snap.replace("  # a comment", "  # reworded")), [], "a comment edit is not a change");
eq(removedEntries(snap, snap.replace("SECRET_THING", "")), [], "removing an internal entry is not breaking");
eq(addedEntries(snap, snap + "[stable .]\nexport function c(): void;\n"), ["[stable .]\texport function c(): void;"], "addition is reported as added");
eq(
  removedEntries(snap, snap.replace("[stable .]", "[stable ./other]")),
  ["[stable .]\texport function a(): void;", "[stable .]\texport function b(x: string): number;"],
  "moving entries to another subpath is a removal",
);
eq([versionAtLeast("0.19.3", "0.20.0"), versionAtLeast("0.20.0", "0.20.0"), versionAtLeast("1.0.0-rc.1", "0.20.0")], [false, true, true], "versionAtLeast");

// --- runtime .d.ts fixtures ---------------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-api-surface-"));
try {
  const pkg = path.join(tmp, "packages/nowaki-runtime");
  mkdirSync(pkg, { recursive: true });
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    writeFileSync(path.join(tmp, rel), text);
  };
  write(
    "packages/nowaki-runtime/package.json",
    JSON.stringify({
      exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./server/*": "./server/*" },
    }),
  );
  const dts = `/** Docs are not part of the surface. */
export interface Ctx {
  /** the URL */
  url: URL;
  formData(): Promise<URLSearchParams>;
}
export function getContext(): Ctx | null;
export function publish(topic: string): void;
`;
  write("packages/nowaki-runtime/index.d.ts", dts);
  write("packages/nowaki-runtime/index.js", "export function getContext() {}\nexport { publish } from './p.js';\nexport const extra = 1;\n");
  const before = genRuntime(tmp);
  eq(before.includes("Docs are not"), false, "runtime: JSDoc stripped");
  eq(before.includes("Ctx.formData(): Promise<URLSearchParams>;"), true, "runtime: interface members on their own lines");
  eq(before.includes("also exports (undeclared, not covered): extra"), true, "runtime: undeclared runtime export noted");
  eq(before.includes("./server/*"), true, "runtime: wildcard subpaths named as not covered");

  // A removed export.
  write("packages/nowaki-runtime/index.d.ts", dts.replace("export function publish(topic: string): void;\n", ""));
  write("packages/nowaki-runtime/index.js", "export function getContext() {}\nexport const extra = 1;\n");
  eq(removedEntries(before, genRuntime(tmp)), ["[stable .]\texport function publish(topic: string): void;"], "removed export is a removal");

  // A changed signature (FormData instead of URLSearchParams).
  write("packages/nowaki-runtime/index.d.ts", dts.replace("URLSearchParams", "FormData"));
  write("packages/nowaki-runtime/index.js", "export function getContext() {}\nexport function publish() {}\n");
  const changed = genRuntime(tmp);
  eq(removedEntries(before, changed), ["[stable .]\tCtx.formData(): Promise<URLSearchParams>;"], "changed signature is a removal");
  eq(addedEntries(before, changed), ["[stable .]\tCtx.formData(): Promise<FormData>;"], "changed signature is also an addition");

  // A new optional member is only an addition.
  write("packages/nowaki-runtime/index.d.ts", dts.replace("  url: URL;", "  url: URL;\n  routePath?: string;"));
  eq(removedEntries(before, genRuntime(tmp)), [], "new interface member is not a removal");

  // A declaration the JS doesn't export fails generation.
  write("packages/nowaki-runtime/index.d.ts", dts + "export function missing(): void;\n");
  throws(() => genRuntime(tmp), /declares missing/, "declared but not exported fails");

  // --- classified inventories ---------------------------------------------------------------
  write("crates/nowaki/src/a.rs", 'fn f() { std::env::var("NOWAKI_SITE"); }\n#[cfg(test)]\nmod tests { const X: &str = "NOWAKI_ONLY_IN_TESTS"; }\n');
  write("packages/nowaki-runtime/server/b.mjs", "const p = process.env.PORT; fetch('/__nowaki/health');\n");
  const env1 = classify(new Map(), "", ["t"]);
  eq(unclassified(env1), [], "classify: empty");
  const prevEnv = "[stable]\nNOWAKI_SITE\nPORT\n";
  const env = genEnv(tmp, prevEnv);
  eq(unclassified(env), [], "env: known names keep their section");
  eq(env.includes("NOWAKI_ONLY_IN_TESTS"), false, "env: Rust test modules are not scanned");
  eq(env.includes("NOWAKI_SITE  # crates/nowaki/src/a.rs"), true, "env: comment lists where it is read");

  // A new env var lands in [unclassified] (and --check fails on it).
  write("packages/nowaki-runtime/server/c.mjs", "if (process.env.NOWAKI_NEW_KNOB) {}\n");
  eq(unclassified(genEnv(tmp, prevEnv)).map((e) => e.split("\t")[1].split("  ")[0]), ["NOWAKI_NEW_KNOB"], "env: a new variable is unclassified");

  // A variable the code no longer reads drops out: a removal when it was stable.
  write("packages/nowaki-runtime/server/b.mjs", "fetch('/__nowaki/health');\n");
  eq(removedEntries(env, genEnv(tmp, env)), ["[stable]\tPORT"], "env: a stable variable no longer read is a removal");

  // A new endpoint lands in [unclassified].
  const http = genHttp(tmp, "[stable]\n/__nowaki/health\n");
  eq(unclassified(http), [], "http: classified endpoint");
  write("packages/nowaki-runtime/server/d.mjs", "fetch('/__nowaki/new-thing');\n");
  eq(unclassified(genHttp(tmp, http)).length, 1, "http: a new endpoint is unclassified");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- the repository's own snapshots -------------------------------------------------------
for (const r of generateAll()) {
  eq(r.text === r.current, true, `api/${r.file} is up to date (node scripts/api-surface.mjs)`);
  eq(unclassified(r.text), [], `api/${r.file} has no unclassified entries`);
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\napi-surface tests: OK");
