// A webhook-style endpoint: third-party services POST here from their own origin, so it opts out of
// the cross-site check that API routes get by default. A route that does this authenticates its
// caller some other way (a signature header, a shared secret) and never relies on cookies.
export const csrf = false;

type Ctx = { bodyJson: () => Promise<unknown> };

export async function POST(ctx: Ctx) {
  const event = await ctx.bodyJson();
  return { body: { received: event !== undefined } };
}
