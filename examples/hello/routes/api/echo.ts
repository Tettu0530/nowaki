// Per-method API exports (GET / POST). Dispatch by method name instead of default.
// A cross-site POST is rejected (403) like a page action; same-origin and Origin-less calls pass.
type Ctx = {
  url: URL;
  json: (data: unknown) => unknown;
  bodyJson: () => Promise<unknown>;
};

export function GET(ctx: Ctx) {
  return ctx.json({ method: "GET", q: ctx.url.searchParams.get("q"), origin: ctx.url.origin });
}

export async function POST(ctx: Ctx) {
  const received = await ctx.bodyJson();
  return ctx.json({ method: "POST", received });
}
