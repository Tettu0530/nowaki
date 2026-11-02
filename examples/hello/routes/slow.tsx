// A deliberately slow loader. Demo for checking that the loading boundary shows on client navigation.
// `?ms=600` changes the delay (default 400ms).
export const title = "Slow — Nowaki";

export const loader = async (ctx) => {
  const ms = Number(ctx.url.searchParams.get("ms") ?? 400);
  await new Promise((r) => setTimeout(r, Number.isFinite(ms) ? ms : 400));
  return { ms };
};

export default function Slow({ data }) {
  return (
    <main style="font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.25rem">
      <h1 data-testid="slow">Slow page</h1>
      <p>This page's loader takes {data.ms}ms. On client navigation, the loading boundary shows meanwhile.</p>
      <a href="/">Back</a>
    </main>
  );
}
