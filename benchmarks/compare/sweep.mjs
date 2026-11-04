// Runs the whole matrix, strictly one framework at a time. The framework order rotates from one
// scale to the next, so no framework always runs first (or last) on a warm or tired machine.
// Usage: node benchmarks/compare/sweep.mjs [--runs 10] [--frameworks nowaki,astro,...] [--scales 1x1,10x1,...]
//   a scale is <pages>x<islands>
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ORDER } from "./lib/frameworks.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
export const SCALES = ["1x1", "10x1", "100x1", "1000x1", "10x10"];
const runs = arg("runs", "10");
const frameworks = arg("frameworks", ORDER.join(",")).split(",");
const scales = arg("scales", SCALES.join(",")).split(",");

const t0 = Date.now();
scales.forEach((scale, s) => {
  const [pages, islands] = scale.split("x");
  const order = frameworks.map((_, i) => frameworks[(i + s) % frameworks.length]);
  for (const fw of order) {
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "run.mjs"), fw, "--pages", pages, "--islands", islands, "--runs", runs],
      { stdio: "inherit" },
    );
    if (r.status !== 0) {
      console.error(`${fw} at ${scale} failed (exit ${r.status}); stopping the sweep`);
      process.exit(1);
    }
  }
});
console.log(`sweep done in ${Math.round((Date.now() - t0) / 60000)} min`);
