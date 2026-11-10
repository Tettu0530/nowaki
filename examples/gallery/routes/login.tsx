// Sign-in: the action checks the password from env.ts (server-only), rotates the session on
// sign-in (regenerate), and stores the user. Cross-site POSTs are refused before it runs.
import type { LoaderContext } from "@nowaki-dev/runtime";
import { env } from "@nowaki-dev/runtime/env/server";
import { localePath } from "@nowaki-dev/runtime/navigation";
import { t } from "../lib/i18n.ts";

export const title = "Sign in";

export async function action(ctx: LoaderContext) {
  const form = await ctx.formData();
  if (form.get("password") !== env.GALLERY_ADMIN_PASSWORD) {
    ctx.status(401);
    return { error: true };
  }
  await ctx.session.regenerate();
  await ctx.session.set("user", "admin");
  // ctx.redirect adds the basePath; localePath keeps the visitor's locale.
  return ctx.redirect(localePath("/account", ctx.locale));
}

export default function Login({ actionData }: { actionData?: { error?: boolean } }) {
  return (
    <main>
      <h1>{t("signIn")}</h1>
      <form method="post" id="login">
        <label>
          {t("password")} <input type="password" name="password" autocomplete="current-password" required />
        </label>{" "}
        <button type="submit">{t("signIn")}</button>
      </form>
      {actionData?.error && (
        <p id="login-error" class="error">
          {t("wrongPassword")}
        </p>
      )}
    </main>
  );
}
