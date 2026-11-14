// ISR demo. Opt in with `export const revalidate = <seconds>` and `nowaki start` caches HTML
// per path; when stale, it serves the old copy immediately and regenerates in the background.
// CDN/edge deployments get the same behavior via Cache-Control (s-maxage + stale-while-revalidate).
import { nonce, type PageProps } from "@nowaki-dev/runtime";

export const revalidate = 2;

export const title = "ISR — Nowaki";
// Inline style with nonce(): scripts/csp-e2e.mjs checks cached (HIT) responses still get a fresh
// CSP nonce on it.
export const meta = () => ({ head: `<style nonce="${nonce()}">.isr-renders{font-variant-numeric:tabular-nums}</style>` });

// Module-scoped counter. Increments on each regeneration (loader run).
let renders = 0;

export const loader = async () => {
  renders += 1;
  return { renders, at: new Date().toISOString() };
};

export default function Isr({ data }: PageProps<typeof loader>) {
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:4rem auto">
      <h1>ISR demo</h1>
      <p>
        This page is cached with <code>export const revalidate = 2</code>. Reloading within
        2 seconds returns the same HTML (cache HIT). After 2 seconds it serves the old HTML while regenerating in the background.
      </p>
      <p>
        render #<strong data-testid="isr-renders">{data.renders}</strong> · generated at{" "}
        <code data-testid="isr-at">{data.at}</code>
      </p>
      <p>
        Check the response's <code>x-nowaki-cache</code> header (HIT / STALE / MISS) and{" "}
        <code>Cache-Control</code>.
      </p>
      <a href="/">Back</a>
    </main>
  );
}
