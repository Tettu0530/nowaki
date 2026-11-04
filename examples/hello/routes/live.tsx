// Server-reactive island demo. Interactive without sending component JS to the client.
// Also shows it coexisting with a client island (Counter, optimistic UI).
import LiveCounter from "../islands/LiveCounter.tsx";
import Counter from "../islands/Counter.tsx";
import LiveTicks from "../islands/LiveTicks.tsx";

export default function LivePage() {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Jetstream island</h1>
      <p>
        A Jetstream island ships <strong>no component JavaScript</strong>. Clicks go to the server
        over a WebSocket; the server re-renders and pushes an HTML patch that the client morphs in.
      </p>
      <LiveCounter />
      <p style="margin-top:1rem;color:#667">
        connected clients (presence): <strong data-nowaki-presence>0</strong>
      </p>
      <p style="margin-top:1rem">
        A live query: <code>POST /api/tick</code> calls <code>publish("ticks")</code> and this
        island updates without being clicked.
      </p>
      <LiveTicks />
      <p style="margin-top:2rem">
        Below is a regular client island (hydrated, optimistic) on the same page — the two kinds
        coexist:
      </p>
      <Counter start={10} />
    </main>
  );
}
