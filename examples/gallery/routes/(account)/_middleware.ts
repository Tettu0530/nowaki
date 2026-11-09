// A route group: (account)/ adds no URL segment, and this middleware runs only for the routes
// inside it (/account here; not for 404s). Without a signed-in user it sends the visitor to sign in.
import type { LoaderContext } from "@nowaki-dev/runtime";
import { localePath } from "@nowaki-dev/runtime/navigation";

export default async function requireUser(ctx: LoaderContext) {
  const user = await ctx.session.get<string>("user");
  if (!user) return ctx.redirect(localePath("/login", ctx.locale));
  ctx.state.user = user;
}
