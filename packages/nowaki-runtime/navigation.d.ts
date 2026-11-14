// Types for `@nowaki-dev/runtime/navigation`: typed links and the i18n helpers. `nowaki typegen`
// augments NowakiRoutes in .nowaki/types.d.ts with the app's routes; until then RoutePath is string.

import type { VNode } from "preact";

/** Route pattern → params type, filled in by typegen: `{ "/blog/[slug]": { slug: string } }`. */
export interface NowakiRoutes {}

type Keys = keyof NowakiRoutes & string;

/** Union of known route paths (string until types are generated). */
export type RoutePath = [Keys] extends [never] ? string : Keys;

type ParamsOf<P extends string> = P extends keyof NowakiRoutes
  ? NowakiRoutes[P]
  : Record<string, string | string[]>;

/** Routes without params, usable as a `<Link href>` as written. */
type StaticRoutePath = [Keys] extends [never]
  ? string
  : { [P in Keys]: {} extends ParamsOf<P> ? P : never }[Keys];

/** A checked href: what `route()`, `href()`, `localePath()` and `routePath()` return. */
export type Href = string & { readonly __nowaki: "href" };

/**
 * Builds the route path of `pattern` with its params filled in. Each param is percent-encoded; a
 * catch-all's array is joined with `/`. The result has no basePath or locale prefix: `<Link>` and
 * `href()` add those. Unknown routes, missing params, and wrong keys are compile errors.
 *   route("/about")                       // no params
 *   route("/blog/[slug]", { slug: "hi" }) // required params
 *   route("/files/[...path]", { path: ["a", "b"] }) // catch-all takes an array
 */
export function route<P extends RoutePath>(
  pattern: P,
  ...args: {} extends ParamsOf<P> ? [] : [params: ParamsOf<P>]
): Href;

/** Props of {@link Link}. Other props pass through to the `<a>`. */
export interface LinkProps {
  /** A route without params (type-checked), or an href built with `route()`. */
  href: StaticRoutePath | Href;
  class?: string;
  className?: string;
  target?: string;
  rel?: string;
  /** Turns off client navigation for this link: a click is a full page load. */
  "data-no-router"?: boolean;
  /** `false` keeps `href` as written under nowaki.config `basePath` (default: the base is added). */
  basePath?: boolean;
  /**
   * i18n. By default the link stays in the current locale: on `/ja/x`, `href="/about"` renders
   * `/ja/about` (an href that already has a locale prefix keeps it). A locale links to `href` in
   * that locale (`localePath(href, locale)`) with `hreflang` set; inside an island, a click also
   * remembers the choice for locale detection (`setLocale`). `false` leaves `href` as written
   * (the base is still added). No effect without `i18n` in nowaki.config.
   */
  locale?: string | false;
  /**
   * Runs this navigation as a View Transition (`document.startViewTransition`). Renders
   * `data-nowaki-transition`, which also works on a plain `<a>` or on an element around links.
   * The client router transitions when the browser supports it and the visitor doesn't prefer
   * reduced motion; otherwise it swaps the page as usual. A page can opt in all navigations to and
   * from it with `export const viewTransition = true` instead. The transition carries the type
   * `"forward"` (`"back"` for a back navigation) for `:active-view-transition-type()`.
   */
  viewTransition?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

/**
 * A typed `<a>`. The client router handles a click on it as a client navigation, as for any `<a>`.
 * Its `href` goes through {@link href}: the current locale (i18n) and basePath go in front.
 */
export function Link(props: LinkProps): VNode;

/** Options of {@link href}. */
export interface HrefOptions {
  /** A locale to link to instead of the current one, or `false` for no locale prefix. */
  locale?: string | false;
  /** `false` leaves basePath out. */
  basePath?: boolean;
}

/**
 * The browser path of a route path, the way `<Link>` builds its href: in the current locale
 * (with `i18n`; a path that already has a locale prefix keeps it) and under basePath. For the URLs
 * `<Link>` doesn't build, such as `<form action={href("/logout")}>`, `fetch(href("/api/x"))` or
 * `location.assign(...)`. Works in components, layouts and islands. Without i18n and basePath,
 * `path` comes back as it is.
 *   href("/logout")                 // "/gallery/ja/logout" on a ja page under basePath "/gallery"
 *   href("/about", { locale: "en" }) // "/gallery/about"
 *   href("/api/x", { locale: false }) // "/gallery/api/x"
 */
export function href(path: StaticRoutePath | Href, options?: HrefOptions): Href;
export function href(path: string, options?: HrefOptions): string;

/**
 * The current locale with `i18n` in nowaki.config (`ctx.locale` of the request being rendered,
 * usable in components, layouts and islands). In the browser it is the page's locale. Undefined
 * without i18n, outside a page request, and in server functions. Also exported from
 * `@nowaki-dev/runtime`.
 */
export function getLocale(): string | undefined;

/**
 * `path` in `locale`, default the current one, without basePath: `localePath("/about", "ja")` →
 * `"/ja/about"`, `localePath("/ja/about", "en")` → `"/about"` when `en` is the default locale, and
 * `localePath(route("/photo/[id]", { id: "1" }), "ja")` → `"/ja/photo/1"`. The query and fragment
 * are kept; without i18n, `path` comes back unchanged. A link doesn't need it (`<Link href>`
 * already keeps the current locale, and `<Link locale="ja">` switches it); use it for a path in
 * another locale outside a link, or `href()` for one under basePath.
 */
export function localePath(path: StaticRoutePath | Href, locale?: string): Href;
export function localePath(path: string, locale?: string): string;

/**
 * Remembers `locale` as the visitor's choice when nowaki.config has `i18n.detect`: sets the
 * `nowaki_locale` cookie (Path = basePath, one year, SameSite=Lax), which the site's root follows
 * instead of `Accept-Language`. Call it from an island (a language switcher) before navigating;
 * a `<Link locale>` used inside an island does it on click. Does nothing on the server. Also
 * exported from `@nowaki-dev/runtime`.
 */
export function setLocale(locale: string): void;

/**
 * The route path of a browser URL: nowaki.config `basePath` and a locale prefix taken off, the query
 * and fragment left out (`/gallery/ja/photo/1` → `/photo/1`). The inverse of {@link href}, and
 * the browser-side counterpart of `ctx.routePath`; works in components, layouts and islands. Use
 * it to link to the current page in another locale: `<Link href={routePath(url)} locale="ja">`.
 */
export function routePath(url: URL | string): Href;

/**
 * A `view-transition-name` for a `style` prop, so an element morphs into the element of the same
 * name on the next page during a View Transition (`<Link viewTransition>` or
 * `export const viewTransition`). `name` becomes a CSS identifier: characters other than letters,
 * digits, `-`, `_` and non-ASCII ones become `_`, and a name starting with a digit or equal to a
 * keyword (`none`, `auto`, ...) gets a leading `_`. Target it in CSS as
 * `::view-transition-group(<name>)`.
 *
 * List to detail: give each card in the list its own name and the detail page's element the
 * same one. Names must be unique on a page, so key them by the item.
 *
 *   // routes/photos/index.tsx
 *   <Link viewTransition href={route("/photos/[id]", { id })}>
 *     <img src={src} style={transitionName(`photo-${id}`)} />
 *   </Link>
 *   // routes/photos/[id].tsx
 *   <img src={src} style={transitionName(`photo-${params.id}`)} />
 *
 * Spread it to combine with other styles: `style={{ ...transitionName(id), width: 320 }}`.
 */
export function transitionName(name: string | number): { viewTransitionName: string };
