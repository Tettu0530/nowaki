// Dependency-free .env loader: the app root's .env and .env.local fill unset process.env keys.
// Precedence, the same as crates/nowaki-core/src/env.rs dotenv_values (shared fixture:
// crates/nowaki-core/tests/fixtures/dotenv-cases.json): .env, then .env.local over it, then the
// real environment over both.

import { readFileSync } from "node:fs";
import path from "node:path";

function parse(content) {
  const out = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv(root = process.cwd()) {
  // A later file overrides an earlier one, so .env.local wins over .env.
  const merged = {};
  for (const file of [".env", ".env.local"]) {
    let content;
    try {
      content = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    Object.assign(merged, parse(content));
  }
  // The real environment wins over both files.
  for (const [k, v] of Object.entries(merged)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
