// サーバーリアクティブ島のサーバー側ヘルパ。状態は Rust(WS) が接続ごとに保持し、
// Node は純粋な再評価だけを行う。返す html はラッパ無しの中身（クライアントが morph で当てる）。

import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";

import { sign, verify } from "./live-sign.mjs";

// Rust の /__nowaki/live WS から呼ばれる。`handler` が無ければ状態そのままで再描画する。
// state 偽造を防ぐためハンドラ実行の前に必ず sig を検証し、新 state には新しい署名を付けて返す。
export async function liveRender(mod, state, handler, payload, name, sig) {
  if (!verify(name, state, sig)) {
    throw new Error("live state signature invalid");
  }
  let next = state;
  const on = mod.live?.on;
  if (handler && on && typeof on[handler] === "function") {
    next = await on[handler](state, payload);
    if (next === undefined) next = state;
  }
  const html = await renderToStringAsync(h(mod.default, { state: next, __nowakiLiveInner: true }));
  return { state: next, html, sig: sign(name, next) };
}

export function liveInitialState(mod, props) {
  const init = mod.live?.state;
  if (typeof init === "function") return init(props ?? {});
  if (init && typeof init === "object") return init;
  return {};
}
