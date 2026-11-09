// i18n routing (nowaki.config `i18n`): every locale but the default is a first path segment
// (`/ja/about`), the default has none (`/about`) unless `prefixDefaultLocale`. Routes stay
// locale-agnostic: handler.mjs splits the locale off the route path and routes the rest.
// Runtime-neutral (no node: imports): the client's localePath / <Link locale> use it too. The Rust
// side of prerender (crates/nowaki/src/prerender.rs `locale_url`) builds the same URLs;
// crates/nowaki/tests/fixtures/i18n-cases.json drives both.

/// The compiled i18n settings from a normalized routing config (dist/server/routing.json), or
/// null without `i18n`.
export function compileI18n(routing) {
  const c = routing?.i18n;
  if (!c || !Array.isArray(c.locales) || !c.locales.length) return null;
  return {
    locales: [...c.locales],
    set: new Set(c.locales),
    defaultLocale: c.defaultLocale,
    prefixDefault: c.prefixDefaultLocale === true,
    // Kept for building browser URLs (hreflang alternates, the default-locale redirect).
    base: routing.basePath ?? "",
    trailing: routing.trailingSlash ?? "ignore",
  };
}

/// The locale a route path starts with: `{ locale, path, prefixed }`, `path` being the route path
/// without it (`/ja/about` → `/about`, `/ja` and `/ja/` → `/`). A path without a configured locale
/// prefix is the default locale's, unchanged. Locale segments match exactly (case included).
export function splitLocale(i18n, path) {
  const end = path.indexOf("/", 1);
  const first = end < 0 ? path.slice(1) : path.slice(1, end);
  if (first && i18n.set.has(first)) {
    return { locale: first, path: end < 0 ? "/" : path.slice(end), prefixed: true };
  }
  return { locale: i18n.defaultLocale, path, prefixed: false };
}

/// `path` for `locale`: an existing locale prefix is replaced, the default locale gets none unless
/// `prefixDefaultLocale`. Without i18n (or for a locale that isn't configured) `path` is returned
/// as it is. The query and fragment are kept.
export function localePathFor(i18n, path, locale) {
  const s = String(path);
  if (!i18n || !s.startsWith("/") || s.startsWith("//") || !i18n.set.has(locale)) return s;
  const cut = s.search(/[?#]/);
  const pathname = cut < 0 ? s : s.slice(0, cut);
  const tail = cut < 0 ? "" : s.slice(cut);
  const bare = splitLocale(i18n, pathname).path;
  if (locale === i18n.defaultLocale && !i18n.prefixDefault) return bare + tail;
  return (bare === "/" ? `/${locale}` : `/${locale}${bare}`) + tail;
}

/// What the browser sees for a route path: basePath in front (the bare base for `/`), and a
/// trailing slash under `trailingSlash: "always"` (not on file names).
export function browserPathFor(i18n, path) {
  let out = path === "/" && i18n.base ? i18n.base : i18n.base + path;
  if (i18n.trailing === "always" && !out.endsWith("/") && !out.slice(out.lastIndexOf("/") + 1).includes(".")) out += "/";
  return out;
}

/// The page's URL in every locale, as [[locale, browser path]] in config order, for
/// `<link rel="alternate" hreflang>` and the sitemap's alternates.
export function localeAlternates(i18n, path) {
  return i18n.locales.map((l) => [l, browserPathFor(i18n, localePathFor(i18n, path, l))]);
}

/// The sitemap's alternates: each path of `paths` that exists in more than one locale, mapped to
/// [[locale, path]] for each of them, then `x-default` (the default locale's), in config order.
export function localeGroups(i18n, paths) {
  const groups = new Map();
  for (const p of paths) {
    const s = splitLocale(i18n, p);
    // A default-locale prefix is never a page's URL (it redirects) unless prefixDefaultLocale.
    if (s.prefixed === (s.locale === i18n.defaultLocale && !i18n.prefixDefault)) continue;
    let g = groups.get(s.path);
    if (!g) groups.set(s.path, (g = new Map()));
    g.set(s.locale, p);
  }
  const out = new Map();
  for (const g of groups.values()) {
    if (g.size < 2) continue;
    const links = i18n.locales.filter((l) => g.has(l)).map((l) => [l, g.get(l)]);
    if (g.has(i18n.defaultLocale)) links.push(["x-default", g.get(i18n.defaultLocale)]);
    for (const p of g.values()) out.set(p, links);
  }
  return out;
}

/// What the client needs for localePath / getLocale, as the `<html data-nowaki-i18n>` value.
export function clientI18n(i18n, locale) {
  return JSON.stringify({ locale, locales: i18n.locales, defaultLocale: i18n.defaultLocale, prefixDefaultLocale: i18n.prefixDefault });
}

/// The other side of clientI18n: `{ locale, i18n }` from the attribute's value, or null.
export function parseClientI18n(raw) {
  try {
    const v = JSON.parse(raw);
    const i18n = compileI18n({ i18n: v });
    return i18n ? { locale: v.locale, i18n } : null;
  } catch {
    return null;
  }
}
