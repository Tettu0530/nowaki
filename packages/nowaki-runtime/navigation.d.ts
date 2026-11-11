// Types for type-safe navigation. `nowaki typegen` augments NowakiRoutes in .nowaki/types.d.ts
// to register the actual routes. Until then, RoutePath falls back to string.

import type { VNode } from "preact";

/** Generated types register path → params type here, e.g. { "/blog/[slug]": { slug: string } }. */
export interface NowakiRoutes {}

type Keys = keyof NowakiRoutes & string;

/** Union of known route paths (string until types are generated). */
export type RoutePath = [Keys] extends [never] ? string : Keys;

type ParamsOf<P extends string> = P extends keyof NowakiRoutes
  ? NowakiRoutes[P]
  : Record<string, string | string[]>;

/** Union of static routes without params (usable directly as a Link href). */
type StaticRoutePath = [Keys] extends [never]
  ? string
  : { [P in Keys]: {} extends ParamsOf<P> ? P : never }[Keys];

/** Branded type for a validated href returned by route(). */
export type Href = string & { readonly __nowaki: "href" };

/**
 * Builds a type-safe href for a dynamic route.
 *   route("/about")                       // no params
 *   route("/blog/[slug]", { slug: "hi" }) // required params
 *   route("/files/[...path]", { path: ["a", "b"] }) // catch-all takes an array
 * Unknown routes, missing params, and wrong keys are compile errors.
 */
export function route<P extends RoutePath>(
  pattern: P,
  ...args: {} extends ParamsOf<P> ? [] : [params: ParamsOf<P>]
): Href;

export interface LinkProps {
  /** A static route (type-checked), or an href built with route(). */
  href: StaticRoutePath | Href;
  class?: string;
  className?: string;
  target?: string;
  rel?: string;
  /** Disables SPA navigation and falls back to a full page load. */
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
  children?: unknown;
  [key: string]: unknown;
}

/**
 * A typed <a>. The client router handles it as an SPA navigation. Its `href` is built by
 * {@link href}: the current locale (i18n) and basePath go in front.
 */
export function Link(props: LinkProps): VNode;

export interface HrefOptions {
  /** A locale to link to instead of the current one, or `false` for no locale prefix. */
  locale?: string | false;
  /** `false` leaves basePath out. */
  basePath?: boolean;
}

/**
 * A path as the browser requests it, the way `<Link>` builds its href: in the current locale
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

/** The current locale with `i18n` in nowaki.config (see `getLocale` in `@nowaki-dev/runtime`). */
export function getLocale(): string | undefined;

/**
 * `path` in `locale`, default the current one (see `localePath` in `@nowaki-dev/runtime`). A
 * static route or a `route()` href stays a `<Link href>`:
 * `<Link href={localePath(route("/photo/[id]", { id }))}>`.
 */
export function localePath(path: StaticRoutePath | Href, locale?: string): Href;
export function localePath(path: string, locale?: string): string;

/** Remembers the visitor's locale for `i18n.detect` (see `setLocale` in `@nowaki-dev/runtime`). */
export function setLocale(locale: string): void;
