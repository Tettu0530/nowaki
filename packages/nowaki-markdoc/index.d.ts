import type { NowakiPlugin } from "@nowaki-dev/runtime/config";

/** A Markdoc tag or node schema. `render` names an HTML element (lowercase) or an export of the
 * `components` module (capitalized). See https://markdoc.dev/docs/tags. */
export type Schema = {
  render?: string;
  attributes?: Record<string, unknown>;
  children?: string[];
  selfClosing?: boolean;
  inline?: boolean;
  [key: string]: unknown;
};

export type MarkdocOptions = {
  /** The module (path from the app root) whose exports render capitalized tags, like
   * `"./markdoc/components.tsx"`. Required when the schema renders a component. */
  components?: string;
  /** Custom tags: `{% callout type="note" %}…{% /callout %}`. */
  tags?: Record<string, Schema>;
  /** Overrides for Markdoc's built-in nodes (heading, fence, link, …). */
  nodes?: Record<string, Schema>;
  /** Variables (`{% $name %}`); `$frontmatter` is the file's own frontmatter. */
  variables?: Record<string, unknown>;
  functions?: Record<string, unknown>;
  partials?: Record<string, unknown>;
  /** Parses the frontmatter text (`format` is "yaml" for `---`, "toml" for `+++`). The built-in
   * reader handles flat key/value pairs and lists of scalars. */
  parseFrontmatter?: (raw: string, format: "yaml" | "toml") => Record<string, unknown>;
  /** The app root `components` is relative to (default: the working directory). */
  root?: string;
};

/** The plugin type of nowaki.config `plugins`, from `@nowaki-dev/runtime/config`. */
export type { NowakiPlugin } from "@nowaki-dev/runtime/config";

/** The plugin: `plugins: [markdoc({ components: "./markdoc/components.tsx", tags })]` in
 * nowaki.config.mjs. Compiles `.mdoc` files at build / dev time. */
export function markdoc(options?: MarkdocOptions): NowakiPlugin;
export default markdoc;

/** One `.mdoc` source to the TSX module the plugin emits. Throws on validation errors. */
export function compileMarkdoc(source: string, id: string, options?: MarkdocOptions): string;

/** Markdoc's own `Tag` class and default schemas, for extending them. */
export const Tag: typeof import("@markdoc/markdoc").Tag;
export const nodes: typeof import("@markdoc/markdoc").nodes;
export const tags: typeof import("@markdoc/markdoc").tags;
export const functions: typeof import("@markdoc/markdoc").functions;
