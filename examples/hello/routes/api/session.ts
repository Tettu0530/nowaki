// ctx.session demo (options in ../../session.ts). GET reads it; POST changes it:
//   op=login&user=…  regenerate (new cookie on sign-in) and remember the user
//   op=inc           count requests in the session
//   op=logout        destroy it (the cookie is deleted)
// A cross-site POST is rejected (403) before the handler runs. (Middleware that reads the session on
// such a request sees it empty and read-only.)
import type { LoaderContext } from "@nowaki-dev/runtime";

async function state(ctx: LoaderContext) {
  return {
    user: (await ctx.session.get<string>("user")) ?? null,
    n: (await ctx.session.get<number>("n")) ?? 0,
    readOnly: ctx.session.readOnly,
  };
}

export async function GET(ctx: LoaderContext) {
  return state(ctx);
}

export async function POST(ctx: LoaderContext) {
  const form = await ctx.formData();
  let wrote: true | string = true;
  try {
    switch (form.get("op")) {
      case "login":
        await ctx.session.regenerate();
        await ctx.session.set("user", form.get("user") ?? "");
        break;
      case "inc":
        await ctx.session.set("n", ((await ctx.session.get<number>("n")) ?? 0) + 1);
        break;
      case "logout":
        await ctx.session.destroy();
        break;
    }
  } catch (err) {
    wrote = (err as Error).message;
  }
  return { ...(await state(ctx)), wrote };
}
