// 依存を増やさないための最小 .env ローダー（cwd の .env / .env.local → 未設定の process.env）。

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
  // .env.local が .env を上書きする慣例だが、既存の process.env は尊重する
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
