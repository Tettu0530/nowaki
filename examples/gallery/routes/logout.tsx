// Sign-out: destroy() clears the values and expires the cookie.
import type { LoaderContext } from "@nowaki-dev/runtime";
import { localePath } from "@nowaki-dev/runtime/navigation";

export async function action(ctx: LoaderContext) {
  await ctx.session.destroy();
  return ctx.redirect(localePath("/", ctx.locale));
}

// A GET has nothing to sign out of: back to the gallery.
export function loader(ctx: LoaderContext) {
  return ctx.redirect(localePath("/", ctx.locale));
}

export default function Logout() {
  return null;
}
