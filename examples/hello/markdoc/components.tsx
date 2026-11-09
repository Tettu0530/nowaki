// Components for Markdoc tags (see `markdoc()` in nowaki.config.mjs). A tag whose schema says
// `render: "Callout"` renders this module's `Callout` export; an island re-exported here hydrates
// like anywhere else.
import type { ComponentChildren } from "preact";

export { default as Counter } from "../islands/Counter.tsx";

export function Callout({ type = "note", children }: { type?: string; children?: ComponentChildren }) {
  return (
    <aside class={`callout callout-${type}`} data-testid="callout">
      {children}
    </aside>
  );
}
