// Choosing the Jetstream transport. By default live.js uses the /__nowaki/live WebSocket and sends an
// event over POST /__nowaki/live-event whenever the socket isn't open. This meta tag pins it:
// "post" never opens the socket (presence stays at its SSR value), "ws" never falls back to POST.
import LiveCounter from "../islands/LiveCounter.tsx";

export const head = `<meta name="nowaki-live" content="post" />`;

export default function LivePostPage() {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Jetstream over HTTP</h1>
      <p>Each click is one POST request carrying the island's signed state.</p>
      <LiveCounter />
    </main>
  );
}
