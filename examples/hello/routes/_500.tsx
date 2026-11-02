// Error page (500) shown when a loader/render throws.
// In dev, error.message includes the stack (auto-reloads once fixed). In prod, the message only.
export const title = "500 — Nowaki";

export default function ErrorPage({ error }: { error: { message: string } }) {
  // /boom?boom=nested: the error page itself fails, so Nowaki falls back to its built-in 500.
  if (error?.message === "nested-500-demo") throw new Error("the 500 page failed too");
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
