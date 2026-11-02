// Unmatched requests get a 404 with this page.
export const title = "404 — Nowaki";

export default function NotFound({ url }: { url: URL }) {
  return (
    <main>
      <h1>404</h1>
      <p>Page not found: <code>{url.pathname}</code></p>
      <a href="/">Back to home</a>
    </main>
  );
}
