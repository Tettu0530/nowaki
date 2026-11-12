// Runs before every request under /posts. Reading is public, and a GET reads nothing per visitor,
// so the pages stay cacheable (ISR). Writes (the caption form's POST) need a signed-in user: the
// session is read only then. Page actions also refuse cross-site POSTs before the action runs.
import type { LoaderContext } from "@nowaki-dev/runtime";
import { localePath } from "@nowaki-dev/runtime/navigation";

export default async function editorsOnly(ctx: LoaderContext) {
  if (ctx.method === "GET" || ctx.method === "HEAD") return;
  const user = await ctx.session.get<string>("user");
  if (!user) return ctx.redirect(localePath("/login", ctx.locale), 303);
  ctx.state.user = user;
}
