export const title = "404 — Not found";

export default function NotFound({ url }: { url: URL }) {
  return (
    <main>
      <h1>404</h1>
      <p>
        Page not found: <code>{url.pathname}</code>
      </p>
      <a href="/">Back to home</a>
    </main>
  );
}
