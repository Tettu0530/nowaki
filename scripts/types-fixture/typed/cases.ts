// Type cases with `nowaki typegen` output: route() checks params against NowakiRoutes. Run by
// scripts/types-test.mjs.
import { route } from "@nowaki-dev/runtime/navigation";

declare module "@nowaki-dev/runtime/navigation" {
  interface NowakiRoutes {
    "/about": {};
    "/blog/[slug]": { slug: string };
  }
}

export const a = route("/about");
export const b = route("/blog/[slug]", { slug: "hi" });
// @ts-expect-error: a route with params requires them.
export const c = route("/blog/[slug]");
// @ts-expect-error: a route without params takes none.
export const d = route("/about", {});
// @ts-expect-error: unknown routes are errors.
export const e = route("/nope");
