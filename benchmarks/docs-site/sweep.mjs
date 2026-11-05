// Runs both apps at every size, one process at a time; the order alternates per size.
// Usage: node benchmarks/docs-site/sweep.mjs [--runs 5] [--sizes 20,100,500]
import { spawnSync } from "node:child_process";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const runs = arg("runs", "5");
const sizes = arg("sizes", "20,100,500").split(",");
const t0 = Date.now();
sizes.forEach((n, s) => {
  for (const fw of s % 2 ? ["astro", "nowaki"] : ["nowaki", "astro"]) {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "run.mjs"), fw, "--entries", n, "--runs", runs], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`${fw} at ${n} entries failed (exit ${r.status}); stopping`);
      process.exit(1);
    }
  }
});
console.log(`sweep done in ${Math.round((Date.now() - t0) / 60000)} min`);
