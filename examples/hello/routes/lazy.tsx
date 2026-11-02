// Lazy hydration (client:* directives) demo. client:visible waits until visible,
// client:idle hydrates when idle, and client:only skips SSR and renders on the client only.
import Counter from "../islands/Counter.tsx";
import ClientOnly from "../islands/ClientOnly.tsx";

export const title = "Lazy hydration — Nowaki";

export default function Lazy() {
  return (
    <main style="font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1.25rem">
      <h1>Lazy hydration</h1>

      <section data-testid="sec-load">
        <h2>client:load (default, immediate)</h2>
        <Counter start={0} />
      </section>

      <section data-testid="sec-idle">
        <h2>client:idle</h2>
        <Counter start={10} client:idle />
      </section>

      <section data-testid="sec-only">
        <h2>client:only (no SSR)</h2>
        <ClientOnly client:only />
      </section>

      {/* Push the counter below the fold (it doesn't hydrate until visible) */}
      <div style="height:150vh" aria-hidden="true" />

      <section data-testid="sec-visible">
        <h2>client:visible</h2>
        <Counter start={100} client:visible />
      </section>
    </main>
  );
}
