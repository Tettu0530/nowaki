// Types for `@nowaki-dev/markdoc/render`: the renderer the compiled `.mdoc` modules import.

/**
 * A serialized Markdoc tree: `[name, attributes, children]` for a tag ("" for a fragment), a
 * string for text.
 */
export type MarkdocNode = string | [string, Record<string, unknown>, MarkdocNode[]];

/**
 * Renders a tree with Preact. Capitalized names must be exports of `components`. Throws for an
 * unknown component and for elements that run code (`script`, `style`, `iframe`, ...); `on*`
 * attributes and `javascript:` / `data:` URLs are dropped.
 */
export function renderMarkdoc(
  node: MarkdocNode | null,
  components?: Record<string, unknown>,
): import("preact").ComponentChild;
