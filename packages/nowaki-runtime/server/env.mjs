// Dependency-free .env loader: the app root's .env and .env.local fill unset process.env keys.

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
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv(root = process.cwd()) {
  // Only unset keys are filled: process.env wins, then .env, then .env.local (the first file
  // read wins a key both define).
  for (const file of [".env", ".env.local"]) {
    let content;
    try {
      content = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parse(content))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
