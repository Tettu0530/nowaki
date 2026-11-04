// Per-method API exports (GET / POST). Dispatch by method name instead of default.
// Reject cross-site POSTs now (API routes only warn by default for the time being).
export const csrf = true;
type Ctx = {
  url: URL;
  json: (data: unknown) => unknown;
  bodyJson: () => Promise<unknown>;
};

export function GET(ctx: Ctx) {
  return ctx.json({ method: "GET", q: ctx.url.searchParams.get("q") });
}

export async function POST(ctx: Ctx) {
  const received = await ctx.bodyJson();
  return ctx.json({ method: "POST", received });
}
