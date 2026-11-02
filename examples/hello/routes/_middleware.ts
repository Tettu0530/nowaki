// _middleware.ts runs before requests under its directory (nestable).
// Returning a Response (ctx.redirect etc.) short-circuits; otherwise it continues.
export default function middleware(ctx: {
  url: URL;
  setHeader: (k: string, v: string) => unknown;
  redirect: (to: string) => unknown;
}) {
  // Evidence the middleware ran (header manipulation demo)
  ctx.setHeader("x-nowaki-mw", "1");

  // Auth guard demo: /secret redirects to the top page unless ?key=ok.
  if (ctx.url.pathname === "/secret" && ctx.url.searchParams.get("key") !== "ok") {
    return ctx.redirect("/");
  }
}
