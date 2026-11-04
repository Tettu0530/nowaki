// Jetstream room: every connection showing the same poll shares one state (`live.shared`), held by
// the server. A vote from one tab re-renders the poll in every other tab, with no client JS of ours.
type Votes = { a: number; b: number };

export const live = {
  room: (props: { id?: string }) => `poll:${props.id ?? "demo"}`,
  shared: (): Votes => ({ a: 0, b: 0 }),
  on: {
    vote: (votes: Votes, option: unknown) =>
      option === "a" || option === "b" ? { ...votes, [option]: votes[option] + 1 } : votes,
  },
};

export default function LivePoll({ state }: { state: Votes }) {
  return (
    <div style="display:flex;gap:1rem;align-items:center">
      <button data-live="vote" value="a">A</button>
      <strong data-testid="votes">a: {state.a} · b: {state.b}</strong>
      <button data-live="vote" value="b">B</button>
    </div>
  );
}
