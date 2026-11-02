// Error page (500) shown when a loader/render throws.
// In dev, error.message includes the stack (auto-reloads once fixed). In prod, the message only.
export const title = "500 — Nowaki";

export default function ErrorPage({ error }: { error: { message: string } }) {
  return (
    <main>
      <h1>500</h1>
      <p>A server error occurred.</p>
      <pre style="white-space:pre-wrap;background:#f6f6f6;padding:1rem;border-radius:6px;overflow:auto">
        {error?.message}
      </pre>
      <a href="/">Back to home</a>
    </main>
  );
}
