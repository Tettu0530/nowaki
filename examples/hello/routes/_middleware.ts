// _middleware.ts runs before requests under its directory (nestable).
// Returning a response (ctx.redirect and so on) ends the request there; otherwise it goes on to the route.
export default function middleware(ctx: {
  url: URL;
  setHeader: (k: string, v: string) => unknown;
  redirect: (to: string) => unknown;
}) {
  // A response header showing that the middleware ran.
  ctx.setHeader("x-nowaki-mw", "1");

  // Auth guard demo: /secret redirects to the top page unless ?key=ok.
  if (ctx.url.pathname === "/secret" && ctx.url.searchParams.get("key") !== "ok") {
    return ctx.redirect("/");
  }
}
