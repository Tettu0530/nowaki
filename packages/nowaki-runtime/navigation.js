// 型安全なナビゲーション（@nowaki-dev/runtime/navigation）。バレルから分離してあるので
// クライアント島から import しても node:async_hooks を巻き込まない。

import { h } from "preact";

// route("/blog/[slug]", { slug: "x" }) → "/blog/x"。
// catch-all（[...path]）は配列を "/" で連結する。各セグメントは encodeURIComponent。
export function route(pattern, params = {}) {
  return pattern.replace(/\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g, (_, rest, one) => {
    if (rest) {
      const v = params[rest] ?? [];
      return (Array.isArray(v) ? v : [v]).map(encodeURIComponent).join("/");
    }
    return encodeURIComponent(params[one] ?? "");
  });
}

// 型付き <a>。SPA 遷移はクライアントルーターがクリックを横取りして行う（通常の <a> と同じ）。
export function Link(props) {
  return h("a", props);
}
