// Type-safe navigation (@nowaki-dev/runtime/navigation). Kept separate from the barrel so
// importing it from a client island doesn't pull in node:async_hooks.

import { h } from "preact";
import { localePathFor, parseClientI18n } from "./server/i18n.mjs";

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
// `locale` (i18n) links to the page in that locale.
export function Link(props) {
  if (props.locale === undefined) return h("a", props);
  const { locale, ...rest } = props;
  return h("a", { ...rest, href: localePath(String(rest.href ?? ""), locale), hreflang: rest.hreflang ?? locale });
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
