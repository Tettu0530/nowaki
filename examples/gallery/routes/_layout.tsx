// Parallel routes: routes/@modal/ is a slot of this layout. On a client navigation to a photo,
// @modal/(.)photo/[id].tsx fills `slots.modal` over the gallery; otherwise it's @modal/default.tsx.
import "../styles/site.css";
import type { LayoutProps } from "@nowaki-dev/runtime";
import { Link, localePath } from "@nowaki-dev/runtime/navigation";
import LanguageSwitcher from "../islands/LanguageSwitcher.tsx";
import { routePath, t } from "../lib/i18n.ts";

export default function Layout({ children, slots, url }: LayoutProps) {
  return (
    <div class="shell">
      <header class="top">
        <Link href={localePath("/")} class="brand">
          {import.meta.env.PUBLIC_GALLERY_TITLE} {t("gallery")}
        </Link>
        <nav>
          <Link id="account-link" href={localePath("/account")}>
            {t("account")}
          </Link>
          <LanguageSwitcher path={routePath(url)} />
        </nav>
      </header>
      {children}
      {slots.modal}
    </div>
  );
}
