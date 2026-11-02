// Server-side helper for server-reactive islands. Rust (WS) holds state per connection;
// Node only does pure re-evaluation. The returned html is the unwrapped content (the client morphs it in).

import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";

import { sign, verify } from "./live-sign.mjs";

// Called from Rust's /__nowaki/live WS. Without a `handler`, re-renders with the state unchanged.
// To prevent state forgery, always verifies sig before running the handler, and signs the new state on return.
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
