// Writes one app of the docs-site benchmark with n entries.
// Usage: node benchmarks/docs-site/gen.mjs <nowaki|astro> [--entries 20]
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PHOTO_DIRS, PHOTOS, TEMPLATES } from "./lib/templates.mjs";

const HERE = import.meta.dirname;
export const APPS = path.join(HERE, "apps");
// Paths gen.mjs owns in each app: deleted and rewritten on every generate.
export const GENERATED = {
  nowaki: ["nowaki.config.mjs", "styles", "content", "components", "routes", "assets"],
  astro: ["astro.config.mjs", "tsconfig.json", "src"],
};

export function generate(fw, n) {
  const dir = path.join(APPS, fw);
  for (const p of GENERATED[fw]) rmSync(path.join(dir, p), { recursive: true, force: true });
  const files = TEMPLATES[fw](n);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const photos = path.join(dir, PHOTO_DIRS[fw]);
  mkdirSync(photos, { recursive: true });
  for (const k of PHOTOS) copyFileSync(path.join(HERE, "assets", `photo-${k}.jpg`), path.join(photos, `photo-${k}.jpg`));
  return Object.keys(files).length;
}

if (import.meta.main) {
  const fw = process.argv[2];
  const i = process.argv.indexOf("--entries");
  const n = i > 0 ? Number(process.argv[i + 1]) : 20;
  if (!TEMPLATES[fw]) {
    console.error("usage: node benchmarks/docs-site/gen.mjs <nowaki|astro> [--entries N]");
    process.exit(2);
  }
  console.log(`${fw}: ${generate(fw, n)} files, ${n} entries`);
}
