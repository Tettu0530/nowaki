// Jetstream form, input, and change events (scripts/live-browser-test.mjs drives this page).
import LiveTodos from "../islands/LiveTodos.tsx";

export const title = "Live form — Nowaki";

export default function LiveFormPage() {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Live form events</h1>
      <LiveTodos />
    </main>
  );
}
