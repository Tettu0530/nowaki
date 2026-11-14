// Types for `@nowaki-dev/runtime/content`: content collections (content/config.ts, content/<name>/).

import type { StandardSchemaV1 } from "./index.js";

/** A heading in a Markdown entry, with the id of its anchor (`<h2 id="setup">`). */
export interface ContentHeading {
  /** 1 for `<h1>` to 6 for `<h6>`. */
  depth: number;
  /** The heading's text. */
  text: string;
  /** The anchor id. */
  id: string;
}

/** A collection in content/config.ts, made with {@link defineCollection}. */
export interface CollectionDefinition<S extends StandardSchemaV1 = StandardSchemaV1> {
  /**
   * `"markdown"` (default): `.md` / `.mdx` files with YAML (`---`) or TOML (`+++`) frontmatter.
   * `"data"`: `.json` / `.yaml` files.
   */
  type?: "markdown" | "data";
  /** Validates the frontmatter (or the data file). Any Standard Schema library. */
  schema?: S;
}

/** One entry of a collection, as `getCollection` / `getEntry` return it. */
export interface ContentEntry<D = unknown> {
  /** The collection's name. */
  collection: string;
  /**
   * The path under the collection without its extension: `posts/hello`. With i18n, without the
   * locale directory.
   */
  slug: string;
  /**
   * With `i18n` in nowaki.config: the locale of the collection's first-level directory the entry
   * is in (`content/blog/ja/hello.md` → `"ja"`). Undefined for an entry outside a locale directory,
   * which belongs to every locale.
   */
  locale?: string;
  /** The source file, relative to the app root. */
  file: string;
  /** The validated frontmatter or data. */
  data: D;
  /** Markdown entries: the source after the frontmatter. */
  body?: string;
  /** Markdown entries: the rendered HTML, its headings with anchor ids. */
  html?: string;
  /** Markdown entries: the headings of `html`. */
  headings?: ContentHeading[];
  /**
   * MDX entries (`.mdx`): the compiled module's component and headings. Render `<Content />`
   * where Markdown entries put `html`; components and islands it imports work as in TSX.
   */
  render?: () => Promise<{ Content: (props?: Record<string, unknown>) => unknown; headings: ContentHeading[] }>;
}

/**
 * Collections by name. `nowaki typegen` fills this in from content/config.ts, so getCollection
 * and getEntry are typed per collection. Without it, entries are `ContentEntry<unknown>`.
 */
export interface Collections {}

type DataOf<K> = K extends keyof Collections ? Collections[K] : unknown;

/** The validated data type of a collection definition (its schema's output). Used by typegen. */
export type CollectionData<C> = C extends { schema?: infer S }
  ? S extends { readonly "~standard": { readonly types?: infer T } }
    ? T extends { readonly output: infer O }
      ? O
      : unknown
    : unknown
  : unknown;

/**
 * Declares a collection in content/config.ts. `schema` (any Standard Schema library) validates
 * the frontmatter or the data file; `nowaki build` fails on an invalid entry.
 * @example export const blog = defineCollection({ schema: z.object({ title: z.string() }) });
 */
export declare function defineCollection<S extends StandardSchemaV1>(
  def: CollectionDefinition<S>,
): CollectionDefinition<S>;

/** The options object of `getCollection`. */
export interface CollectionQuery<D> {
  /**
   * i18n: the entries of this locale (and those outside any locale directory), or `"*"` for every
   * entry. Defaults to the current request's locale (`getLocale()`); without i18n, every entry.
   */
  locale?: string;
  /** Keeps the entries it returns true for. */
  filter?: (entry: ContentEntry<D>) => boolean;
}

/**
 * Every entry of a collection, sorted by slug; `filter` (a function, or `{ filter }`) keeps the
 * ones it returns true for. With i18n, only the current locale's entries and the locale-less
 * ones, unless `{ locale }` says otherwise. Throws for an unknown collection.
 */
export declare function getCollection<K extends string>(
  name: K,
  filter?: ((entry: ContentEntry<DataOf<K>>) => boolean) | CollectionQuery<DataOf<K>>,
): Promise<ContentEntry<DataOf<K>>[]>;

/**
 * One entry by slug, or undefined. With i18n, the current locale's (or `{ locale }`'s), falling
 * back to the entry outside any locale directory.
 */
export declare function getEntry<K extends string>(
  name: K,
  slug: string,
  options?: { locale?: string },
): Promise<ContentEntry<DataOf<K>> | undefined>;
