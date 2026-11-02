// CI: the repo is English-only (AGENTS.md > Conventions). Fails on Japanese text in
// tracked files, except the site's `ja` locale and the brand / language names.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED_FILES = new Set(["site/lib/i18n.ts"]);
const ALLOWED_WORDS = /野分|日本語/g;
const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const hits = [];
for (const file of files) {
  if (ALLOWED_FILES.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("�")) continue; // binary
  text.split("\n").forEach((line, i) => {
    if (CJK.test(line.replace(ALLOWED_WORDS, ""))) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}

if (hits.length) {
  console.error(`Japanese text found in ${hits.length} line(s); the repo is English-only:\n`);
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log(`english-only: OK (${files.length} files)`);
