// <Link locale> links to the same page in another locale. Inside an island, its click also sets
// the nowaki_locale cookie, so the next visit to /gallery keeps the choice over Accept-Language.
import { getLocale, Link, type Href } from "@nowaki-dev/runtime/navigation";
import { locales } from "../lib/i18n.ts";

export default function LanguageSwitcher({ path }: { path: Href }) {
  const current = getLocale();
  return (
    <span class="lang">
      {locales.map(({ code, label }) =>
        code === current ? (
          <strong key={code} aria-current="true">{label}</strong>
        ) : (
          <Link key={code} id={`lang-${code}`} href={path} locale={code}>
            {label}
          </Link>
        ),
      )}
    </span>
  );
}
