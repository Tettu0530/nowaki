// Early streaming: `streaming = "early"` sends the document shell before the loader runs, so the
// first byte doesn't wait for data. The trade-off: once the shell is out, the status is fixed.
// A loader redirect becomes a client-side redirect, and a loader error renders error.tsx in the
// page. `meta` only sees the static exports (`title`, `head`).
// Try `?fail=1` (loader error) and `?go=1` (loader redirect).
import type { LoaderContext } from "@nowaki-dev/runtime";

export const streaming = "early";
export const title = "Early streaming — Nowaki";

export const loader = async (ctx: LoaderContext) => {
  await new Promise((r) => setTimeout(r, 300)); // a slow data fetch
  if (ctx.url.searchParams.has("fail")) throw new Error("the data source is down");
  if (ctx.url.searchParams.has("go")) return ctx.redirect("/about");
  return { loadedAt: new Date().toISOString() };
};

export default function StreamEarly({ data }: { data: { loadedAt: string } }) {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Early streaming</h1>
      <p data-testid="early">
        The shell arrived before the loader finished; it loaded at <strong>{data.loadedAt}</strong>.
      </p>
    </main>
  );
}
