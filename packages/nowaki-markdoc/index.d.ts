// Types for `@nowaki-dev/markdoc`: the nowaki.config plugin that compiles `.mdoc` files.

import type { NowakiPlugin } from "@nowaki-dev/runtime/config";

/**
 * A Markdoc tag or node schema. `render` names an HTML element (lowercase) or an export of the
 * `components` module (capitalized). See https://markdoc.dev/docs/tags.
 */
export type Schema = {
  render?: string;
  attributes?: Record<string, unknown>;
  children?: string[];
  selfClosing?: boolean;
  inline?: boolean;
  [key: string]: unknown;
};

/** The options of {@link markdoc}. */
export type MarkdocOptions = {
  /**
   * The module (path from the app root) whose exports render capitalized tags, like
   * `"./markdoc/components.tsx"`. Required when the schema renders a component.
   */
  components?: string;
  /** Custom tags: `{% callout type="note" %}…{% /callout %}`. */
  tags?: Record<string, Schema>;
  /** Overrides for Markdoc's built-in nodes (heading, fence, link, …). */
  nodes?: Record<string, Schema>;
  /** Variables (`{% $name %}`); `$frontmatter` is the file's own frontmatter. */
  variables?: Record<string, unknown>;
  /** Markdoc functions (`{% if equals($a, 1) %}`). */
  functions?: Record<string, unknown>;
  /** Markdoc partials by file name (`{% partial file="header.mdoc" /%}`). */
  partials?: Record<string, unknown>;
  /**
   * Parses the frontmatter text (`format` is "yaml" for `---`, "toml" for `+++`). The built-in
   * reader handles flat key/value pairs and lists of scalars.
   */
  parseFrontmatter?: (raw: string, format: "yaml" | "toml") => Record<string, unknown>;
  /** The app root `components` is relative to (default: the working directory). */
  root?: string;
};

/** The plugin type of nowaki.config `plugins`, from `@nowaki-dev/runtime/config`. */
export type { NowakiPlugin } from "@nowaki-dev/runtime/config";

/**
 * The plugin. Compiles `.mdoc` files at build / dev time into modules that render with Preact.
 * Throws a TypeError on invalid options.
 * @example plugins: [markdoc({ components: "./markdoc/components.tsx", tags })] // nowaki.config.mjs
 */
export function markdoc(options?: MarkdocOptions): NowakiPlugin;
export default markdoc;

/**
 * Compiles one `.mdoc` source (`id` is its path) to the TSX module the plugin emits. Throws on
 * validation errors.
 */
export function compileMarkdoc(source: string, id: string, options?: MarkdocOptions): string;

/** Markdoc's own `Tag` class, for a `transform` that builds tags. */
export const Tag: typeof import("@markdoc/markdoc").Tag;
/** Markdoc's default node schemas, for extending them in `nodes`. */
export const nodes: typeof import("@markdoc/markdoc").nodes;
/** Markdoc's built-in tag schemas (`if`, `else`, `partial`, `table`, `slot`). */
export const tags: typeof import("@markdoc/markdoc").tags;
/** Markdoc's built-in functions (`equals`, `and`, `or`, `not`, `default`, `debug`). */
export const functions: typeof import("@markdoc/markdoc").functions;
