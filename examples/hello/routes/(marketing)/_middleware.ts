// Middleware in a route group runs for the routes inside the group (not for 404s).
export default function middleware(ctx: { setHeader: (k: string, v: string) => unknown }) {
  ctx.setHeader("x-route-group", "marketing");
}
