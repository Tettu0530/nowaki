/** A serialized Markdoc tree: `[name, attributes, children]` for a tag ("" for a fragment), a
 * string for text. */
export type MarkdocNode = string | [string, Record<string, unknown>, MarkdocNode[]];

/** Renders a tree with Preact. Capitalized names must be exports of `components`. */
export function renderMarkdoc(
  node: MarkdocNode | null,
  components?: Record<string, unknown>,
): import("preact").ComponentChild;
