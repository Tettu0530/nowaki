// Async/dynamic metadata: title/head/lang can be built from loader results and params.
export async function meta({ params }: { params: { path: string[] } }) {
  const p = Array.isArray(params.path) ? params.path.join("/") : "";
  return { title: `files/${p} — Nowaki` };
}

// For `nowaki prerender`; a function (sync or async) works too.
export const staticPaths = () => [{ path: ["docs", "intro"] }];

// catch-all route: /files/a/b/c -> params.path === ["a", "b", "c"]
export default function Files({ params }: { params: { path: string[] } }) {
  const segs = Array.isArray(params.path) ? params.path : [];
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:4rem auto">
      <h1>Catch-all route</h1>
      <p>
        <code>routes/files/[...path].tsx</code> matched.
      </p>
      <p data-testid="catchall">
        {segs.join(" / ")} ({segs.length})
      </p>
    </main>
  );
}
