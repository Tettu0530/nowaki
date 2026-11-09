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
   * i18n: links to `href` in this locale (`localePath(href, locale)`), with `hreflang` set. Used
   * inside an island, a click also remembers the choice for locale detection (`setLocale`).
   */
  locale?: string;
  children?: unknown;
  [key: string]: unknown;
}

/** A typed <a>. The client router handles it as an SPA navigation. */
export function Link(props: LinkProps): VNode;

/** The current locale with `i18n` in nowaki.config (see `getLocale` in `@nowaki-dev/runtime`). */
export function getLocale(): string | undefined;

/** `path` in `locale`, default the current one (see `localePath` in `@nowaki-dev/runtime`). */
export function localePath(path: string, locale?: string): string;

/** Remembers the visitor's locale for `i18n.detect` (see `setLocale` in `@nowaki-dev/runtime`). */
export function setLocale(locale: string): void;
