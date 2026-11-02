// client:* 遅延ハイドレーション指令（load/idle/visible/media/only、既定 load）の解釈と
// <nowaki-island> ラップ。dev / prod / edge で共有する。oxc は名前空間付き JSX 属性を
// `"client:visible"` のような prop キーとして渡すので、変換側の改修は不要。

import { h } from "preact";

import { stableStringify } from "./serialize.mjs";

const STRATEGIES = new Set(["load", "idle", "visible", "media", "only"]);

// 指令キーはシリアライズ対象から除外し、島へ prop としては渡さない。
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

// client:only はクライアント専用 API を使う島向けに SSR しない。
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
