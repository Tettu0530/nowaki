// Server-side helper for server-reactive islands. Rust (WS) holds state per connection, or the
// client sends it back with each POST event; Node only does pure re-evaluation. The returned html is the unwrapped content (the client morphs it in).

import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";

import { makeContext } from "./context.mjs";
import { sign, verify } from "./live-sign.mjs";

/// The request context for live handlers, from the headers the Rust front captured at the WebSocket
/// upgrade (cookie, authorization, accept-language, user-agent, public host). Cookies set after the
/// socket opened are seen after the next reconnect.
export function liveContext(request) {
  if (!request || typeof request !== "object") return null;
  const headers = {};
  for (const [k, v] of Object.entries(request.headers ?? {})) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
  }
  const proto = headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const url = new URL("/__nowaki/live", `${proto}://${headers["x-forwarded-host"] ?? "localhost"}`);
  return makeContext({ url, method: "POST", headers, readBody: async () => new Uint8Array() });
}

/// Thrown when an island's `live.authorize` refuses an event; servers answer it with 403.
export class LiveForbiddenError extends Error {
  constructor() {
    super("live event not authorized");
    this.name = "LiveForbiddenError";
  }
}

// Called for the /__nowaki/live WS and POST /__nowaki/live-event. Without a `handler`, re-renders
// with the state unchanged.
// To prevent state forgery, always verifies sig before running the handler, and signs the new state on return.
// `live.authorize({ name, handler, state, payload })` runs after the signature check and before the
// handler; anything but `true` refuses the event. getContext() works in both (see sidecars).
export async function liveRender(mod, state, handler, payload, name, sig) {
  if (!verify(name, state, sig)) {
    throw Object.assign(new Error("live state signature invalid"), { code: "NOWAKI_LIVE_SIG" });
  }
  const authorize = mod.live?.authorize;
  if (handler && typeof authorize === "function" && (await authorize({ name, handler, state, payload })) !== true) {
    throw new LiveForbiddenError();
  }
  let next = state;
  const on = mod.live?.on;
  // Own keys only: the name comes from the client, so inherited ones like `toString` must not run.
  if (handler && on && Object.hasOwn(on, handler) && typeof on[handler] === "function") {
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
