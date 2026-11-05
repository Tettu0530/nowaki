// Node: loads the content collections `nowaki build` wrote into <serverDir>/content, validates
// them against content/config, and puts them in the store getCollection reads. Used by the
// production server, the staticPaths pass of `nowaki prerender`, and the build-time check.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setContent, validateContent } from "./content-store.mjs";

/// Returns null when the app has no content/, else `{ collections, errors }` (also stored).
export async function loadContent(serverDir) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(serverDir, "content/index.json"), "utf8"));
  } catch {
    return null;
  }
  const config = await import(pathToFileURL(path.join(serverDir, "content/config.js")).href);
  const state = await validateContent(raw, config, (e) => import(pathToFileURL(path.join(serverDir, e.module)).href));
  setContent(state);
  return state;
}
