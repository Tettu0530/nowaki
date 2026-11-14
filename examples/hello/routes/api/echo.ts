// Per-method API exports: GET and POST each answer their method (names are uppercase); with no
// `default` export, other methods get 405.
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
