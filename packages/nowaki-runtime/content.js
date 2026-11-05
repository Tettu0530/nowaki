// Content collections: declare them in content/config.ts with defineCollection, then read them in
// loaders (and staticPaths) with getCollection / getEntry. Entries come from content/<name>/;
// Markdown is rendered at build time, so `html` and `headings` are ready to use.
import { contentState } from "./server/content-store.mjs";

/// `schema`: any Standard Schema (Zod, Valibot, ArkType, …) for the frontmatter (Markdown) or
/// the file's contents (`type: "data"`, for .json / .yaml entries).
export function defineCollection(def = {}) {
  return Object.freeze({ type: "markdown", ...def, __nowakiCollection: true });
}

function collection(name) {
  const state = contentState();
  if (!state) {
    throw new Error("Content collections aren't loaded: add content/config.ts (see defineCollection).");
  }
  if (state.errors?.length) {
    throw new Error(`Content collections have errors:\n  ${state.errors.join("\n  ")}`);
  }
  const entries = state.collections[name];
  if (!entries) {
    const known = Object.keys(state.collections);
    throw new Error(`Unknown collection "${name}". Collections: ${known.length ? known.join(", ") : "none"}`);
  }
  return entries;
}

/// Every entry of a collection, sorted by slug; `filter` keeps the ones it returns true for.
export async function getCollection(name, filter) {
  const all = collection(name);
  return typeof filter === "function" ? all.filter(filter) : [...all];
}

/// One entry by slug (`posts/hello` for content/blog/posts/hello.md), or undefined.
export async function getEntry(name, slug) {
  return collection(name).find((e) => e.slug === slug);
}
