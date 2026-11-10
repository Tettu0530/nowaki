// The request's locale for code that has no ctx: getLocale() / localePath() (navigation.js),
// getCollection (content.js), the document's lang and hreflang links (handler.mjs). Only an app
// with i18n runs requests in it, so other apps pay nothing. The reader is published on globalThis
// so navigation.js and content.js, which client bundles import too, never import node:async_hooks.

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();
const KEY = Symbol.for("nowaki.locale");

/// Runs `fn` with `state` (`{ locale, i18n, path?, prefix? }`) as the current locale.
export function runWithLocale(state, fn) {
  return store.run(state, fn);
}

/// The current locale state, or undefined outside a localized request.
export function localeState() {
  return store.getStore();
}

globalThis[KEY] = localeState;
