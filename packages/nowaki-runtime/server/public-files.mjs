// public/: files served as-is at their own path, for the Node-hosted adapters (node / bun / deno,
// and the Vercel function, which has none: Vercel serves them as static files). `nowaki build`
// copies public/ to dist/public/; the rules match nowaki-core's `public` module: dotfiles and
// dot-directories are left out except `.well-known/`, and `/_nowaki/` / `/__nowaki/` are never
// public paths.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const segmentOk = (s) => s !== "" && s !== ".." && (!s.startsWith(".") || s === ".well-known");

/// Map of decoded URL path → { file, etag } for every file under `dir` (empty if it's missing).
/// Built once at startup: a request that isn't a public file costs one map lookup.
export async function indexPublic(dir) {
  const out = new Map();
  const walk = async (d, prefix) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!segmentOk(e.name)) continue;
      const file = path.join(d, e.name);
      const url = `${prefix}/${e.name}`;
      let st;
      try {
        st = await stat(file); // follows symlinks, like the copy did
      } catch {
        continue;
      }
      if (st.isDirectory()) await walk(file, url);
      else if (st.isFile()) {
        out.set(url, { file, etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs / 1000).toString(16)}"` });
      }
    }
  };
  await walk(dir, "");
  for (const key of out.keys()) {
    const first = key.split("/")[1];
    if (first === "_nowaki" || first === "__nowaki") out.delete(key);
  }
  return out;
}

/// The entry for a request's (still percent-encoded) pathname, or undefined.
export function lookupPublic(index, pathname) {
  if (index.size === 0) return undefined;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  return index.get(decoded);
}
