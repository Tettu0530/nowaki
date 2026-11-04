// Two-tab voting demo for Jetstream rooms: open /poll in two tabs and vote in either.
import LivePoll from "../islands/LivePoll.tsx";

export const title = "Live poll — Nowaki";

export default function PollPage() {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Live poll (room)</h1>
      <p>Open this page in two tabs. A vote in one shows up in the other.</p>
      <LivePoll id="demo" />
      <p style="margin-top:1rem;color:#667">
        people here: <strong data-nowaki-presence="poll:demo">0</strong>
      </p>
    </main>
  );
}
