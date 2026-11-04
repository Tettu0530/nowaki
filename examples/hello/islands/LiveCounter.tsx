// Server-reactive island (Jetstream). An island with `export const live` sends no component JS
// to the client. State lives on the server (per connection); events re-render -> an HTML patch is pushed.
// Buttons have no onClick. `data-live="handlerName"` points at a server handler.
import { getContext } from "@nowaki-dev/runtime";

export const live = {
  state: () => ({ count: 0 }),
  on: {
    inc: (s) => ({ ...s, count: s.count + 1 }),
    dec: (s) => ({ ...s, count: s.count - 1 }),
    reset: () => ({ count: 0 }),
    // Handlers read the request (cookies from the WebSocket upgrade) through getContext().
    greet: (s) => ({ ...s, user: getContext()?.cookies?.user ?? "guest" }),
    adminReset: () => ({ count: 0 }),
    // Test fixture (scripts/livetest.mjs): a render that takes a while, for ordering and timeouts.
    slow: async (s) => {
      await new Promise((r) => setTimeout(r, 400));
      return s;
    },
  },
  // Runs before every handler; anything but `true` refuses the event ("forbidden").
  authorize: ({ handler }) => handler !== "adminReset" || getContext()?.cookies?.role === "admin",
};

export default function LiveCounter({ state }) {
  return (
    <div style="display:inline-flex;gap:1rem;align-items:center;border:1px solid #ccc;padding:1rem;border-radius:8px">
      <button data-live="dec">-</button>
      <strong>live: {state.count}</strong>
      {state.user && <span>hi {state.user}</span>}
      <button data-live="inc">+</button>
      <button data-live="reset" style="font-size:.85rem;color:#666">reset</button>
    </div>
  );
}
