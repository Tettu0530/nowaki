// Writes the generated sources of one framework's blog app (or every framework's) at a given scale.
// Usage: node benchmarks/compare/gen.mjs <framework|all> [--pages 10] [--islands 1] [--mode static|server]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FRAMEWORKS, ORDER } from "./lib/frameworks.mjs";
import { TEMPLATES } from "./lib/templates.mjs";

export const APPS = path.join(import.meta.dirname, "apps");

export function generate(fw, { pages, islands, mode, isr = false }) {
  if (!FRAMEWORKS[fw]) throw new Error(`unknown framework: ${fw}`);
  if (!["static", "server"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const dir = path.join(APPS, fw);
  for (const p of FRAMEWORKS[fw].generated) rmSync(path.join(dir, p), { recursive: true, force: true });
  const files = TEMPLATES[fw]({ pages, islands, mode, isr });
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return Object.keys(files).length;
}

if (import.meta.main) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const which = process.argv[2];
  const opts = { pages: Number(arg("pages", 10)), islands: Number(arg("islands", 1)), mode: arg("mode", "static") };
  const list = which === "all" ? ORDER : [which];
  if (!which || list.some((f) => !FRAMEWORKS[f])) {
    console.error(`usage: node benchmarks/compare/gen.mjs <${ORDER.join("|")}|all> [--pages N] [--islands N] [--mode static|server]`);
    process.exit(2);
  }
  for (const fw of list) console.log(`${fw}: ${generate(fw, opts)} files (${opts.pages} pages, ${opts.islands} islands, ${opts.mode})`);
}
