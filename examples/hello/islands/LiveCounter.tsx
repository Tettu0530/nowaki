// Server-reactive island (Jetstream). An island with `export const live` sends no component JS
// to the client. State lives on the server (per connection); events re-render -> an HTML patch is pushed.
// Buttons have no onClick. `data-live="handlerName"` points at a server handler.

export const live = {
  state: () => ({ count: 0 }),
  on: {
    inc: (s) => ({ ...s, count: s.count + 1 }),
    dec: (s) => ({ ...s, count: s.count - 1 }),
    reset: () => ({ count: 0 }),
  },
};

export default function LiveCounter({ state }) {
  return (
    <div style="display:inline-flex;gap:1rem;align-items:center;border:1px solid #ccc;padding:1rem;border-radius:8px">
      <button data-live="dec">-</button>
      <strong>live: {state.count}</strong>
      <button data-live="inc">+</button>
      <button data-live="reset" style="font-size:.85rem;color:#666">reset</button>
    </div>
  );
}
