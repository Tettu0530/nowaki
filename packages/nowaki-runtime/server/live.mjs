// Server-side helper for server-reactive islands. Rust (WS) holds state per connection, or the
// client sends it back with each POST event; Node only does pure re-evaluation. The returned html is the unwrapped content (the client morphs it in).

import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";

import { makeContext } from "./context.mjs";
import { sign, verifyStatus } from "./live-sign.mjs";
import { publish } from "./publish.mjs";

// Rooms: islands with `live.room(props)` share one state per room id (`live.shared()`), held here in
// this process. The island's own signed state is just `{ room }`, so a client can't move itself into
// another room; every render reads the shared state of the signed room.
const rooms = new Map();
const ROOM_ID = /^[^\s]{1,120}$/;

function roomIdOf(mod, props) {
  if (typeof mod.live?.room !== "function") return null;
  const id = String(mod.live.room(props ?? {}));
  if (!ROOM_ID.test(id)) throw new Error("live.room must return 1-120 characters without whitespace");
  return id;
}

// Persistence hooks (Node only: live-rooms-file.mjs uses them; edge bundles never call them).
let roomsChanged = null;
export function onRoomsChange(cb) {
  roomsChanged = cb;
}
export function exportRooms() {
  return Object.fromEntries(rooms);
}
/// Restores saved rooms; ids that wouldn't pass `live.room` are dropped. Returns the count kept.
export function importRooms(saved) {
  let n = 0;
  for (const [id, value] of Object.entries(saved ?? {})) {
    if (ROOM_ID.test(id) && value !== undefined) {
      rooms.set(id, value);
      n++;
    }
  }
  return n;
}

function sharedOf(mod, room, props) {
  if (!rooms.has(room)) {
    const init = mod.live?.shared;
    rooms.set(room, typeof init === "function" ? init(props ?? {}) : (init ?? {}));
  }
  return rooms.get(room);
}

const isRoomIsland = (mod) => typeof mod.live?.room === "function";

/// What the component renders with: the room's shared state for room islands, else the state.
export function liveView(mod, state) {
  return isRoomIsland(mod) && typeof state?.room === "string" ? sharedOf(mod, state.room) : state;
}

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
/// `live.subscribe`: an array of topics, or a function of the state returning one. Capped like live.rs
/// (16 topics, 128 chars each) since the client echoes them back on join.
export function liveTopics(mod, state) {
  const room = isRoomIsland(mod) && typeof state?.room === "string" ? [`room:${state.room}`] : [];
  const sub = mod.live?.subscribe;
  let topics;
  try {
    topics = typeof sub === "function" ? sub(state) : sub;
  } catch {
    topics = null;
  }
  if (!Array.isArray(topics)) return room;
  return room.concat(
    topics.filter((t) => typeof t === "string" && t.length > 0 && t.length <= 128 && !/[\r\n]/.test(t)),
  ).slice(0, 16);
}

/// `load: { topic }` is a `publish(topic)` refresh: `live.load(state, { topic })` replaces the
/// handler. The result carries the island's current topics.
export async function liveRender(mod, state, handler, payload, name, sig, { load } = {}) {
  const status = verifyStatus(name, state, sig);
  if (status === "expired") {
    // The page outlived NOWAKI_LIVE_MAX_AGE: the client reloads it for a fresh signature.
    throw Object.assign(new Error("live state signature expired"), { code: "NOWAKI_LIVE_STALE" });
  }
  if (status !== "ok") {
    throw Object.assign(new Error("live state signature invalid"), { code: "NOWAKI_LIVE_SIG" });
  }
  const authorize = mod.live?.authorize;
  if (handler && typeof authorize === "function" && (await authorize({ name, handler, state, payload })) !== true) {
    throw new LiveForbiddenError();
  }
  if (isRoomIsland(mod)) return roomRender(mod, state, handler, payload, name, sig);
  let next = state;
  if (load && typeof mod.live?.load === "function") {
    next = (await mod.live.load(state, { topic: String(load.topic ?? "") })) ?? state;
    const html = await renderToStringAsync(h(mod.default, { state: next, __nowakiLiveInner: true }));
    return { state: next, html, sig: sign(name, next), topics: liveTopics(mod, next) };
  }
  const on = mod.live?.on;
  // Own keys only: the name comes from the client, so inherited ones like `toString` must not run.
  if (handler && on && Object.hasOwn(on, handler) && typeof on[handler] === "function") {
    next = await on[handler](state, payload);
    if (next === undefined) next = state;
  }
  const html = await renderToStringAsync(h(mod.default, { state: next, __nowakiLiveInner: true }));
  return { state: next, html, sig: sign(name, next), topics: liveTopics(mod, next) };
}

// A room event updates the shared state and publishes `room:<id>`, so every member (on any
// connection in this process) re-renders; a load refresh just re-renders the current shared state.
async function roomRender(mod, state, handler, payload, name, sig) {
  const room = state?.room;
  if (typeof room !== "string" || !ROOM_ID.test(room)) throw new Error("live room state invalid");
  const shared = sharedOf(mod, room);
  let next = shared;
  const on = mod.live?.on;
  if (handler && on && Object.hasOwn(on, handler) && typeof on[handler] === "function") {
    next = (await on[handler](shared, payload)) ?? shared;
    if (next !== shared) {
      rooms.set(room, next);
      roomsChanged?.();
      publish(`room:${room}`);
    }
  }
  const html = await renderToStringAsync(h(mod.default, { state: next, __nowakiLiveInner: true }));
  return { state, html, sig: sign(name, state), topics: liveTopics(mod, state) };
}

export function liveInitialState(mod, props) {
  const room = roomIdOf(mod, props);
  if (room !== null) {
    sharedOf(mod, room, props);
    return { room };
  }
  const init = mod.live?.state;
  if (typeof init === "function") return init(props ?? {});
  if (init && typeof init === "object") return init;
  return {};
}
