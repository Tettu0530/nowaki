// Parses client:* lazy-hydration directives (load/idle/visible/media/only, default load) and
// wraps in <nowaki-island>. Shared by dev / prod / edge. oxc passes namespaced JSX attributes
// as prop keys like `"client:visible"`, so the transform needs no changes.

import { h } from "preact";

import { stableStringify } from "./serialize.mjs";

const STRATEGIES = new Set(["load", "idle", "visible", "media", "only"]);

// Directive keys are excluded from serialization and not passed to the island as props.
function extractClient(props) {
  let strategy = null;
  let media = null;
  const rest = {};
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("client:")) {
      const s = k.slice("client:".length);
      if (STRATEGIES.has(s)) {
        strategy = s;
        if (s === "media" && typeof v === "string") media = v;
        continue;
      }
    }
    rest[k] = v;
  }
  return { strategy, media, rest };
}

// client:only skips SSR, for islands that use client-only APIs.
export function wrapIsland(island, props, Original) {
  const { __nowakiInner, ...raw } = props;
  void __nowakiInner;
  const { strategy, media, rest } = extractClient(raw);
  const attrs = {
    name: island.name,
    src: island.src,
    props: stableStringify(rest),
    style: "display:contents",
  };
  if (strategy && strategy !== "load") attrs.client = strategy;
  if (media) attrs["client-media"] = media;
  const inner = strategy === "only" ? null : h(Original, { ...rest, __nowakiInner: true });
  return h("nowaki-island", attrs, inner);
}
