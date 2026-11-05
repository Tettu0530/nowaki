import type { StandardSchemaV1 } from "./index.js";

/** A heading in a Markdown entry, with the id of its anchor (`<h2 id="setup">`). */
export interface ContentHeading {
  depth: number;
  text: string;
  id: string;
}

export interface CollectionDefinition<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** `"markdown"` (default): `.md` files with frontmatter. `"data"`: `.json` / `.yaml` files. */
  type?: "markdown" | "data";
  /** Validates the frontmatter (or the data file). Any Standard Schema library. */
  schema?: S;
}

export interface ContentEntry<D = unknown> {
  collection: string;
  /** Path under the collection without its extension: `posts/hello`. */
  slug: string;
  /** The source file, relative to the app root. */
  file: string;
  /** The validated frontmatter or data. */
  data: D;
  /** Markdown entries: the source after the frontmatter. */
  body?: string;
  /** Markdown entries: rendered HTML, headings with anchor ids. */
  html?: string;
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

export declare function defineCollection<S extends StandardSchemaV1>(
  def: CollectionDefinition<S>,
): CollectionDefinition<S>;
export declare function getCollection<K extends string>(
  name: K,
  filter?: (entry: ContentEntry<DataOf<K>>) => boolean,
): Promise<ContentEntry<DataOf<K>>[]>;
export declare function getEntry<K extends string>(
  name: K,
  slug: string,
): Promise<ContentEntry<DataOf<K>> | undefined>;
