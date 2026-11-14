// The error boundary: the UI shown when a client navigation fails.
// The client router wires the message into the data-nowaki-error slot and retry into the
// data-nowaki-reset button (this component itself is not an island).
export default function ErrorBoundary() {
  return (
    <main style="font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.25rem">
      <h1 data-testid="error" style="font-size:1.25rem;margin:0 0 .5rem">
        Couldn't display this page
      </h1>
      <p data-nowaki-error style="color:#56616f;margin:0 0 1.25rem" />
      <button
        data-nowaki-reset
        type="button"
        style="font:inherit;cursor:pointer;border:1px solid #d7dbe0;background:#fff;border-radius:8px;padding:.5rem .9rem"
      >
        Retry
      </button>
    </main>
  );
}
