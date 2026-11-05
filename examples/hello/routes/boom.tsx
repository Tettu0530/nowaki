// Error boundary (_500) demo. The loader throws only with ?boom=1 (or ?boom=nested, which also makes
// _500.tsx throw, to show the built-in fallback). Without the query it renders normally.
type Ctx = { url: URL };

export const title = "Boom — Nowaki";
// A noindex page: the robots meta tag, and no sitemap.xml entry.
export const meta = { robots: { index: false } };

export const loader = (ctx: Ctx) => {
  const boom = ctx.url.searchParams.get("boom");
  if (boom === "nested") throw new Error("nested-500-demo");
  if (boom) throw new Error("Intentional error (_500.tsx demo)");
  return {};
};

export default function Boom() {
  return (
    <main>
      <h1>Boom</h1>
      <p>
        <a href="/boom?boom=1">Trigger a 500 with ?boom=1</a>
      </p>
    </main>
  );
}
