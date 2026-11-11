// Only reachable signed in (see _middleware.ts, which put the user in ctx.state).
import type { LoaderContext } from "@nowaki-dev/runtime";
import { href } from "@nowaki-dev/runtime/navigation";
import { t } from "../../lib/i18n.ts";

export const title = "Account";

export function loader(ctx: LoaderContext) {
  return { user: String(ctx.state.user) };
}

export default function Account({ data }: { data: { user: string } }) {
  return (
    <main>
      <h1>{t("account")}</h1>
      <p id="signed-in">
        {t("signedInAs")}: <strong>{data.user}</strong>
      </p>
      <form method="post" action={href("/logout")}>
        <button type="submit" id="logout">
          {t("signOut")}
        </button>
      </form>
    </main>
  );
}
