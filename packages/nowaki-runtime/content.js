// Content collections: declare them in content/config.ts with defineCollection, then read them in
// loaders (and staticPaths) with getCollection / getEntry. Entries come from content/<name>/;
// Markdown is rendered at build time, so `html` and `headings` are ready to use.
import { contentState, currentLocale } from "./server/content-store.mjs";

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
/// With i18n, only the current locale's entries (and those outside any locale directory); pass
/// `{ locale: "ja" }` for another locale's, or `{ locale: "*" }` for all of them. The options
/// object may carry the filter too: `{ locale, filter }`.
export async function getCollection(name, filterOrOpts) {
  const opts = typeof filterOrOpts === "function" ? { filter: filterOrOpts } : (filterOrOpts ?? {});
  const locale = opts.locale ?? currentLocale();
  let out = collection(name);
  if (locale !== undefined && locale !== "*") out = out.filter((e) => e.locale === undefined || e.locale === locale);
  return typeof opts.filter === "function" ? out.filter(opts.filter) : [...out];
}

/// One entry by slug (`posts/hello` for content/blog/posts/hello.md), or undefined. With i18n,
/// the current locale's entry (or `{ locale }`'s), else the one outside any locale directory.
export async function getEntry(name, slug, opts = {}) {
  const locale = opts.locale ?? currentLocale();
  const all = collection(name).filter((e) => e.slug === slug);
  if (locale === undefined || locale === "*") return all[0];
  return all.find((e) => e.locale === locale) ?? all.find((e) => e.locale === undefined);
}
