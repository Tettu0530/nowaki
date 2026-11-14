// Type-safe navigation (@nowaki-dev/runtime/navigation). Kept separate from the barrel so
// importing it from a client island doesn't pull in node:async_hooks.

import { h } from "preact";
import { basePath, withBase } from "./server/base-path.mjs";
import { localePathFor, parseClientI18n, splitLocale } from "./server/i18n.mjs";

// route("/blog/[slug]", { slug: "x" }) → "/blog/x"。
// A catch-all ([...path]) joins its array with "/". Each segment is encodeURIComponent'd.
export function route(pattern, params = {}) {
  return pattern.replace(/\[(\.\.\.)?([^[\]]+)\]/g, (_, dots, name) => {
    if (dots) {
      const v = params[name] ?? [];
      return (Array.isArray(v) ? v : [v]).map(encodeURIComponent).join("/");
    }
    return encodeURIComponent(params[name] ?? "");
  });
}

// Typed <a>. The client router intercepts clicks for SPA navigation (same as a plain <a>).
// The href goes through href(): under nowaki.config `basePath` a root-relative href gets the base
// in front (`basePath={false}` keeps it as written), and with `i18n` it stays in the current
// locale (`locale="ja"` links to another one, `locale={false}` leaves the href alone). A plain <a>
// is left alone. Inside an island, a click on a `locale` link also remembers the choice
// (setLocale) before the router navigates. `viewTransition` renders data-nowaki-transition: the
// client router runs that navigation as a View Transition (client/router.js).
export function Link(props) {
  if (!globalThis.__nowakiBase && props.basePath === undefined && props.locale === undefined && props.viewTransition === undefined && !localeState()) return h("a", props);
  const { basePath, locale, viewTransition, ...rest } = props;
  if (viewTransition) rest["data-nowaki-transition"] = "";
  if (locale) {
    rest.hreflang ??= locale;
    const onClick = rest.onClick;
    rest.onClick = (e) => (setLocale(locale), onClick?.(e));
  }
  if (typeof rest.href == "string") rest.href = href(rest.href, props);
  return h("a", rest);
}

/// `{ viewTransitionName }` for a `style` prop: `name` as a CSS identifier. Characters other than
/// letters, digits, `-`, `_` and non-ASCII ones become `_`. A leading `_` goes in front of a name
/// that would start with a digit (or `-` and a digit), of "" and "-", and of the keywords a name
/// can't be (`none`, `auto`, `match-element` and the CSS-wide ones).
export function transitionName(name) {
  return {
    viewTransitionName: String(name)
      .replace(/[^\w\u0080-￿-]/g, "_")
      .replace(/^(?=-?\d|-?$|(none|auto|match-element|initial|inherit|unset|revert(-layer)?|default)$)/i, "_"),
  };
}

/// `path` as the browser requests it: in the current locale (i18n; `locale` picks another one,
/// `false` none) and under basePath (`basePath: false` leaves it out). A path that already has a
/// locale prefix keeps it unless `locale` is given. For URLs <Link> doesn't build: form actions,
/// fetch, location.
export function href(path, { locale, basePath } = {}) {
  const st = locale !== false && localeState();
  const s = st ? localePathFor(st.i18n, path, locale ?? st.locale, locale === undefined) : String(path);
  return basePath === false ? s : withBase(s);
}

const STATE = Symbol.for("nowaki.locale");
let parsed = { raw: null, value: null };

// The server's request state (server/i18n-context.mjs), else what the page's
// <html data-nowaki-i18n> says (handler.mjs writes it on every page of an app with i18n).
function localeState() {
  const server = globalThis[STATE]?.();
  if (server) return server;
  if (typeof document === "undefined") return null;
  const raw = document.documentElement.getAttribute("data-nowaki-i18n");
  if (raw !== parsed.raw) parsed = { raw, value: raw ? parseClientI18n(raw) : null };
  return parsed.value;
}

/// The current request's locale (i18n), or undefined (no i18n, or outside a request).
export function getLocale() {
  return localeState()?.locale;
}

/// `path` in `locale` (default: the current one): `/about` → `/ja/about`, `/ja/about` → `/about`
/// for the default locale. Unchanged without i18n.
export function localePath(path, locale) {
  const st = localeState();
  if (!st) return String(path);
  return localePathFor(st.i18n, path, locale ?? st.locale);
}

/// The app path of a browser URL (a URL, or a path string): basePath and a configured locale
/// prefix taken off ("/gallery/ja/photo/1" → "/photo/1"), the query and fragment left out. The
/// counterpart of href(), for links back to the current page in another locale and the like.
export function routePath(url) {
  let p = typeof url === "string" ? url.split(/[?#]/)[0] || "/" : url.pathname;
  const base = basePath();
  if (base && p.startsWith(base) && (p.length === base.length || p[base.length] === "/")) p = p.slice(base.length) || "/";
  const st = localeState();
  return st ? splitLocale(st.i18n, p).path : p;
}

/// Remembers `locale` as the visitor's choice for i18n.detect: the `nowaki_locale` cookie (Path =
/// basePath, a year, SameSite=Lax), which the site's root follows instead of Accept-Language.
/// Browser only; does nothing on the server.
export function setLocale(locale) {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `nowaki_locale=${encodeURIComponent(locale)}; Path=${globalThis.__nowakiBase || "/"}; Max-Age=31536000; SameSite=Lax${secure}`;
}
