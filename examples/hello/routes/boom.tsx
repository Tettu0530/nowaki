// Error boundary (_500) demo. The loader throws only with ?boom=1.
// Without the query (prerender or normal navigation) it renders normally.
type Ctx = { url: URL };

export const title = "Boom — Nowaki";

export const loader = (ctx: Ctx) => {
  if (ctx.url.searchParams.get("boom")) {
    throw new Error("Intentional error (_500.tsx demo)");
  }
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
