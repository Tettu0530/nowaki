// Example API route (server-only). No secrets in responses; validate inputs on real endpoints.
type Ctx = { json: (data: unknown) => unknown };

export function GET(ctx: Ctx) {
  return ctx.json({ ok: true });
}
