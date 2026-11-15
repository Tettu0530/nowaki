// Type tests for @nowaki-dev/runtime's .d.ts files: `tsc --noEmit` over scripts/types-fixture/
// (untyped: before `nowaki typegen`; typed: with NowakiRoutes), with skipLibCheck off so the
// runtime's own declarations are checked too. Each case must compile and each @ts-expect-error
// must still be an error. tsc comes from $TSC, else the workspace's typescript.
// Usage: node scripts/types-test.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = process.env.TSC || path.join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.error(`types-test: no tsc at ${tsc} (run pnpm install, or set TSC)`);
  process.exit(1);
}

let failures = 0;
for (const dir of ["untyped", "typed"]) {
  const project = path.join(root, "scripts", "types-fixture", dir, "tsconfig.json");
  try {
    execFileSync(process.execPath, [tsc, "--noEmit", "-p", project], { stdio: "pipe" });
    console.log(`ok   types-fixture/${dir}`);
  } catch (err) {
    failures++;
    console.log(`FAIL types-fixture/${dir}\n${err.stdout ?? ""}${err.stderr ?? ""}`);
  }
}
if (failures) process.exit(1);
console.log("types: all checks passed");
