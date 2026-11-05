// Guarded by _middleware. Shown only with ?key=ok.
export const title = "Secret — Nowaki";
// Not listed in the generated sitemap.xml.
export const sitemap = false;

export default function Secret() {
  return (
    <main>
      <h1>Secret</h1>
      <p>Passed the middleware guard.</p>
    </main>
  );
}
