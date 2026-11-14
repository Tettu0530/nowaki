// Public types for the Nowaki framework (getContext is also exported as a value).

import type { ComponentChildren } from "preact";

/** Route params. `[slug]` is a string; `[...slug]` (catch-all) is a string[]. */
export type RouteParams = Record<string, string | string[]>;

export interface CookieOptions {
  maxAge?: number;
  expires?: Date | string;
  path?: string;
  domain?: string;
  /** Defaults to true. Set to false explicitly to drop HttpOnly. */
  httpOnly?: boolean;
  secure?: boolean;
  /** Defaults to "Lax". */
  sameSite?: "Lax" | "Strict" | "None" | "lax" | "strict" | "none";
}

export interface ResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * `ctx.session` (and `getContext().session`): per-visitor values kept across requests in an
 * encrypted cookie (or, with a `store` in session.ts, server-side behind a signed id). Values must
 * be JSON. Created on first access; reading it makes an ISR page per-user. Needs
 * `NOWAKI_SESSION_SECRET` in production (dev generates one into `.nowaki/session-secret`).
 */
export interface Session {
  /**
   * True where the session can't be changed: on a cross-site request that changes state (it is
   * also empty there, CSRF), and in live island renders. Writes throw.
   */
  readonly readOnly: boolean;
  get<T = unknown>(key: string): Promise<T | undefined>;
  has(key: string): Promise<boolean>;
  /** Sets a JSON value (`undefined` deletes). Throws when the cookie would pass 4 KB. */
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** A fresh cookie (and, with a store, a new id), keeping the values. Call it on sign-in. */
  regenerate(): Promise<void>;
  /** Clears the values and the cookie. Call it on sign-out. */
  destroy(): Promise<void>;
}

/** Result of ctx.json / html / text / redirect (returning it finalizes the response). */
export interface NowakiResult {
  readonly __nowakiResult: true;
}

/**
 * Shared context passed to loaders, actions, middleware, and API handlers.
 * Bundles the request (url, params, method, headers, cookies, body) and
 * response writers (status, header, cookie, redirect, json, ...).
 */
export interface LoaderContext {
  /** The request URL, as the browser sent it (basePath and locale prefix included). */
  readonly url: URL;
  /**
   * The app path routing used: `url.pathname` without nowaki.config `basePath` and without the
   * locale prefix (`/gallery/ja/photo/1` → `/photo/1`), the form `<Link href>`, `href()` and
   * `revalidatePath()` take. After a config rewrite, it is the rewritten path. In components, use
   * `routePath(url)` from `@nowaki-dev/runtime/navigation`.
   */
  readonly routePath: string;
  /**
   * The site's URL (`NOWAKI_SITE`, or `site` in nowaki.config), for absolute links in feeds and
   * the like. Undefined when neither is set; `url.origin` is the request's own origin.
   */
  readonly site: URL | undefined;
  /** Route params (catch-all values are arrays). */
  readonly params: RouteParams;
  /** The HTTP method. */
  readonly method: string;
  /**
   * The request's locale with `i18n` in nowaki.config: the locale prefix of the URL (`/ja/about`
   * → `"ja"`), else the default locale. Undefined without i18n and for `/__nowaki/*` requests
   * (server functions, live events).
   */
  readonly locale: string | undefined;
  /** Request headers (lowercase keys). */
  readonly headers: Record<string, string>;
  /** Parsed request cookies. */
  readonly cookies: Record<string, string>;
  /**
   * The visitor's session (see {@link Session}). Throws on first access in production when
   * `NOWAKI_SESSION_SECRET` is missing, and while prerendering.
   * @example
   * await ctx.session.regenerate(); // on sign-in
   * await ctx.session.set("userId", user.id);
   */
  readonly session: Session;
  /** Node's IncomingMessage (undefined on Edge). */
  readonly req?: unknown;
  /** Arbitrary data middleware passes to loaders and pages. */
  state: Record<string, unknown>;
  /** The action's return value (passed when the page re-renders). */
  actionData?: unknown;

  /** Gets a request header (case-insensitive). */
  get(name: string): string | undefined;
  /**
   * Reads the request body as `FormData` for both `application/x-www-form-urlencoded` and
   * `multipart/form-data` (same as the platform `Request.formData()`). Text fields are strings;
   * file parts are `File`. `form.get()` is `string | File | null` — read text with
   * `String(form.get("x") ?? "")`. Oversized or malformed bodies throw before user code runs
   * (413/400). **`File.name` is untrusted** (may contain CR/LF or `../`) — sanitize before
   * storage or display.
   */
  formData(): Promise<FormData>;
  /** Reads the request body as a string. */
  bodyText(): Promise<string>;
  /** Reads the request body as JSON. */
  bodyJson<T = unknown>(): Promise<T>;

  /** Sets the response status (chainable). */
  status(code: number): this;
  /** Sets a response header (chainable). */
  setHeader(name: string, value: string): this;
  /** Appends a Set-Cookie header (chainable). */
  setCookie(name: string, value: string, opts?: CookieOptions): this;
  /** Deletes a cookie (Max-Age=0, chainable). */
  deleteCookie(name: string, opts?: CookieOptions): this;

  /**
   * Redirects (302 by default). Return it from a loader, action, or middleware. Under
   * nowaki.config `basePath`, a path starting with `/` gets the base in front unless it already
   * starts with it; `{ basePath: false }` sends `to` as written.
   */
  redirect(to: string, status?: number, opts?: { basePath?: boolean }): NowakiResult;
  redirect(to: string, opts: { basePath?: boolean }): NowakiResult;
  /** Returns a JSON response. */
  json<T>(data: T, init?: ResponseInit): NowakiResult;
  /** Returns an HTML response. */
  html(markup: string, init?: ResponseInit): NowakiResult;
  /** Returns a text/plain response. */
  text(s: string, init?: ResponseInit): NowakiResult;
}

/** Server-only loader. Its return value is passed to the page as `data`. */
export type Loader<T = unknown> = (ctx: LoaderContext) => T | Promise<T>;

/** Action that runs on non-GET requests. Returns a Response/redirect, or data for re-rendering. */
export type Action = (ctx: LoaderContext) => unknown | Promise<unknown>;

/**
 * `export const staticPaths` on a dynamic route: the params to prerender with `nowaki prerender`
 * or the static adapter, one page per entry. A `[...rest]` param takes a string[]. With i18n, a
 * function runs once per locale, given `{ locale }` (also `getLocale()`, so `getCollection` returns
 * that locale's entries), and each page is written under the locale's prefix.
 * @example export const staticPaths: StaticPaths = [{ slug: "hello" }, { slug: "world" }];
 */
export type StaticPaths<P extends RouteParams = RouteParams> =
  | P[]
  | ((info: { locale?: string }) => P[] | Promise<P[]>);

/**
 * `export const budget` on a page route: the most first-load client JS the page may ship, in KB of
 * gzip (the islands runtime, the islands it can render, and the live runtime). `nowaki build`
 * fails when the page goes over it. `js` must be a number literal; `0` means no client JS.
 * @example export const budget = { js: 12 };
 */
export type RouteBudget = { js: number };

/**
 * `export const streaming` on a page route.
 * - `true`: the loaders run first, then the shell is sent and the body streams as it renders
 *   (Suspense boundaries arrive as they settle). A loader redirect or error still sets the status.
 * - `"early"`: the shell is sent before any loader runs, so the first byte doesn't wait for data.
 *   The status and headers are then fixed: `meta` sees only the static `title` / `head`, a loader
 *   redirect becomes a client-side `location.replace`, and a loader error renders the nearest
 *   `error.tsx` in the page (its message only in dev). Cookies set by a loader are not sent.
 */
export type Streaming = boolean | "early";

/**
 * `export const csrf` on a page with an `action`, an API route (`routes/api/**`), or a file route
 * (`feed.xml.ts`). By default (`true`, so exporting `true` changes nothing) a POST / PUT / PATCH /
 * DELETE from another site is rejected with 403 `Forbidden` before the action or handler runs: an
 * `Origin` of another host or `null`, or `Sec-Fetch-Site: cross-site` without `Origin`. Requests
 * without either header (curl, server-to-server, most native apps) and GET / HEAD / OPTIONS are
 * never checked. `_middleware` runs before the check.
 *
 * `false` accepts cross-site writes, for webhooks and third-party callbacks. Authenticate such a
 * route another way (a signature header, a shared secret): its cookies are the visitor's.
 * API routes reject by default since 0.19.3.
 * @example export const csrf = false; // routes/api/webhook.ts
 */
export type Csrf = boolean;

/** API route handler (per-method export or default). */
export type ApiHandler = (
  ctx: LoaderContext,
) => Response | NowakiResult | unknown | Promise<Response | NowakiResult | unknown>;

/** Middleware. Returning a Response/redirect short-circuits the request. */
export type Middleware = (ctx: LoaderContext) => unknown | Promise<unknown>;

/**
 * Attributes for `<html>` / `<body>` (`export const htmlAttrs` / `bodyAttrs` in a route or
 * layout, or from `meta()`). Layouts apply first, then the route, then `meta()`; a later value
 * wins, `false` / `null` removes one set earlier, and `class` values are joined. `true` renders
 * a bare attribute. Event-handler attributes (`on*`) are ignored.
 */
export type DocumentAttrs = Record<string, string | number | boolean | null | undefined>;

/** Page metadata (`<title>` / `<head>` / `<html lang>` / `<html>` and `<body>` attributes). */
export interface Meta {
  title?: string;
  head?: string;
  lang?: string;
  htmlAttrs?: DocumentAttrs;
  bodyAttrs?: DocumentAttrs;
  /** `<meta name="description">`; Open Graph and Twitter fall back to it. */
  description?: string;
  /** `<link rel="canonical">`: a URL or path (against the site), or `true` for this page's path. */
  canonical?: string | true;
  /** `<meta name="robots">`. A noindex page is left out of the generated sitemap.xml. */
  robots?: string | { index?: boolean; follow?: boolean };
  /** Open Graph. `title` / `description` default to the page's; `url` to this page; relative URLs resolve against the site. */
  openGraph?: {
    title?: string;
    description?: string;
    type?: string;
    url?: string;
    siteName?: string;
    locale?: string;
    image?: OpenGraphImage | OpenGraphImage[];
  };
  /** Twitter / X cards. `card` defaults to "summary_large_image"; the rest fall back to Open Graph. */
  twitter?: {
    card?: "summary" | "summary_large_image" | "app" | "player";
    site?: string;
    creator?: string;
    title?: string;
    description?: string;
    image?: string;
    /** Defaults to the Open Graph image's `alt`. */
    imageAlt?: string;
  };
  /** Structured data, one `<script type="application/ld+json">` per object. */
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
}

/** `type` (`og:image:type`) defaults to the URL's extension (`.png` → image/png). */
export type OpenGraphImage = string | { url: string; type?: string; width?: number; height?: number; alt?: string };

/**
 * Route metadata: `export const meta: Meta = {...}`, or a function of the loader data (`MetaFn`).
 * A layout's `meta` object applies to every page under it (page values win; `openGraph` and
 * `twitter` merge one level deep).
 */
/** Dynamic, possibly async metadata. Can be derived from loader data or params. */
export type MetaFn<D = unknown> = (info: {
  data: D;
  params: RouteParams;
  url: URL;
}) => Meta | Promise<Meta>;

/** Props a page component receives. */
export interface RouteProps<D = unknown> {
  /** The loader's return value. */
  data: D;
  /** The action's return value, if any. */
  actionData?: unknown;
  params: RouteParams;
  url: URL;
}

/** Page props with `data` inferred from the loader type. Use as `PageProps<typeof loader>`. */
export type PageProps<L extends Loader<any> = Loader<unknown>> = RouteProps<Awaited<ReturnType<L>>>;

/** Props a `_layout` component receives. */
export interface LayoutProps<D = unknown> {
  /** The layout's loader return value. */
  data: D;
  params: RouteParams;
  url: URL;
  /** The page (or the next layout down). */
  children: ComponentChildren;
  /**
   * Parallel routes: what each slot directory next to this layout (`@modal/` → `slots.modal`)
   * renders, wrapped in `<nowaki-slot name="modal" style="display:contents">`. That's the slot's
   * file matching the URL (`@modal/photo/[id].tsx` for `/photo/42`), else its `default.tsx`, else
   * null. Slot files get `{ data, params, url }` like a page, and their loaders get the slot's
   * params. They don't contribute `meta`.
   *
   * Intercepting routes: a file in a slot whose path has a `(.)` / `(..)` / `(...)` segment
   * (`@modal/(.)photo/[id].tsx`) takes over that URL on client navigation from a page the slot is
   * on: the router fetches just that file and swaps it into the slot (the URL changes, the rest of
   * the page and its island state stay; back restores the slot). A reload or a direct visit
   * renders the full page. Such a slot is always rendered as its `<nowaki-slot>` element, empty
   * when it has nothing to show, so render `slots.modal` even then: it's where the fragment goes.
   */
  slots: Record<string, ComponentChildren>;
}

/**
 * Default export of `routes/loading.tsx`. When a client navigation takes over 150ms,
 * the nearest loading boundary (nestable) is shown until the target HTML arrives. No island needed.
 */
export type LoadingComponent = () => unknown;

/**
 * Props received by the default export of `routes/error.tsx`. When a client navigation fails,
 * the nearest error boundary (nestable) is shown. The client router puts the message into the
 * element marked `data-nowaki-error` and wires retry to the element marked `data-nowaki-reset`.
 */
export interface ErrorPageProps {
  error: { message: string };
  reset: () => void;
}

/**
 * Jetstream (server-reactive island) declaration. When an island has `export const live`,
 * no component JS is sent to the client: the server holds the state and updates via HTML patches.
 */
export interface Live<S = any> {
  /** Initial state (may take props). */
  state: (props?: any) => S;
  /** Handlers keyed by `data-live="name"` event, each returning the new state. */
  on: Record<string, (state: S, payload?: any) => S | Promise<S>>;
  /**
   * Runs after the state signature is verified and before each handler; anything but `true`
   * refuses the event (the client gets `{ type: "error", reason: "forbidden" }`). `getContext()`
   * returns the WebSocket upgrade's cookies and headers here and in handlers.
   */
  authorize?: (event: { name: string; handler: string; state: S; payload?: any }) => boolean | Promise<boolean>;
  /** Live query topics (or a function of the state): `publish(topic)` refreshes these islands. */
  subscribe?: string[] | ((state: S) => string[]);
  /** Runs on `publish(topic)` for a subscribed island; returns the new state to push. */
  load?: (state: S, info: { topic: string }) => S | Promise<S>;
  /**
   * Makes this a room island: every instance with the same room id (1-120 characters, no
   * whitespace) shares one state, `shared()`. Handlers then receive and return the shared state,
   * and every member gets the new HTML. Held in the server process's memory (`nowaki dev` /
   * `nowaki start`); not shared across instances. `nowaki start` saves rooms to
   * `.nowaki/live-rooms.json` (at most every 2 s, and on SIGTERM / SIGINT) and loads them back on
   * the next start (`NOWAKI_LIVE_ROOMS_FILE` picks the file, `off` disables it); under `nowaki dev`
   * they are lost on restart.
   */
  room?: (props: any) => string;
  /** Initial shared state of a room (`live.room`). */
  shared?: (props?: any) => S;
}

/**
 * Refreshes every live island subscribed to `topic` (`live.subscribe`) by running its `live.load`
 * and pushing the patch. Call it from actions, server functions, or API routes after data changes.
 * It reaches the live connections of the same `nowaki dev` / `nowaki start` process. On the deploy
 * adapters (node, bun, deno, cloudflare, vercel) it does nothing and warns once. A topic is 1 to
 * 128 characters without whitespace (else a TypeError).
 */
export function publish(topic: string): void;

/**
 * `export const tags` on an ISR page (one with `export const revalidate`): the cache tags its
 * cached copies carry, so `revalidateTag(tag)` can purge them. An array, or a function of the
 * render's `{ params, data }` returning one. A tag is 1 to 256 characters without whitespace,
 * commas or control characters; at most 64 per page (invalid ones are dropped with a warning).
 * Pages with `streaming = "early"` are never cached, so their tags are unused.
 * @example export const tags = ({ params }) => ["posts", `post:${params.slug}`];
 */
export type RouteTags =
  | string[]
  | ((info: { params: RouteParams; data: any }) => string[]);

/**
 * Purges every cached copy of the page at `path` from the ISR cache, so the next request renders
 * it fresh (and waits for that render). `path` is an app path, as written in `<Link href>`: without
 * the basePath or a locale prefix. Every form a browser can cache it under is purged: each query
 * string and `Vary` variant, each locale, the basePath, and both trailing-slash forms under
 * `trailingSlash: "ignore"`. A rewritten URL is cached under the browser's path; use a tag for it.
 *
 * Call it from a page `action`, an API route, a server function or a live handler after data
 * changes: under `nowaki start` the purge happens before that response is sent, so a redirect
 * after the action already shows fresh content. Calls made outside a request, or after its
 * response was sent (a timer, a queue consumer), reach the cache shortly after. The ISR cache lives in each `nowaki start` process;
 * with several instances, fan the purge out with `POST /__nowaki/revalidate` (see
 * `revalidateTag`). Throws a TypeError for a path that isn't root-relative (`/blog`).
 *
 * Per server:
 *
 * | Server | Cached by | Purge |
 * | --- | --- | --- |
 * | `nowaki start` | the Rust front, in memory per process | deleted before the response is sent |
 * | vercel adapter | Vercel's CDN (ISR pages send `Vercel-Cache-Tag`) | `dangerouslyDeleteByTag` from `@vercel/functions`, awaited up to 2 s before the response; install the package in the app (warned once without it) |
 * | node / bun / deno adapters | whatever CDN is in front (`s-maxage`) | none: a no-op, warned once; purge that CDN through its API |
 * | cloudflare adapter | the Worker, in the Cache API of each data center (custom domains) | the path is deleted from the local data center's cache; with `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` (Cache Purge permission) set on the Worker, a zone purge by tag clears every data center, awaited up to 2 s; without them (or on workers.dev, which has no zone) `revalidateTag` clears nothing, warned once |
 * | static output | files | none: a no-op, warned once |
 * | `nowaki dev` | nothing | calls are only recorded |
 *
 * On Vercel the path is a cache tag too (`p:<browser path>`, next to `t:<tag>`), so both functions
 * purge by tag; a tag over 256 bytes is sent as a hash. Make the call inside the request:
 * `@vercel/functions` purges through the invocation's context, so a call with no request behind
 * it does nothing, and one made after the response may be cut short when the function suspends.
 * On Cloudflare the tags go in `Cache-Tag` (a tag over 240 characters is sent as a hash; tags
 * are case-insensitive there, so a purge can catch more than asked). The zone purge API is rate
 * limited per account (on the Free plan 5 requests a minute, bursts of 25); a rejected purge is
 * warned once.
 * @example revalidatePath("/blog");
 */
export function revalidatePath(path: string): void;

/**
 * Purges every cached ISR page tagged `tag` (`export const tags`), with the same timing and
 * reach as `revalidatePath`. Throws a TypeError for an invalid tag.
 *
 * To purge every `nowaki start` instance, set `NOWAKI_REVALIDATE_SECRET` and send each one
 * `POST /__nowaki/revalidate` with `Authorization: Bearer <secret>` and a JSON body
 * `{ "paths": ["/blog"], "tags": ["posts"] }` (at most 256 entries). The endpoint is off (404)
 * while the variable is unset.
 * @example revalidateTag(`post:${ctx.params.slug}`);
 */
export function revalidateTag(tag: string): void;

/**
 * While a server function (`"use server"`), a page `action`, an API route, or a live handler /
 * `live.authorize` is running, returns that call's LoaderContext (for live, the WebSocket
 * upgrade's cookie, authorization, accept-language, and user-agent headers). Returns null
 * elsewhere. Use it for auth.
 */
export function getContext(): LoaderContext | null;

// The i18n helpers, the same functions (and types) as `@nowaki-dev/runtime/navigation`.
export { getLocale, href, localePath, setLocale } from "./navigation.js";

/** A [Standard Schema](https://standardschema.dev) (zod, valibot, arktype, ...). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
      }>;
    };

// Libraries declare `types`; a hand-written schema falls back to what `validate` resolves with.
type SchemaInput<S> = S extends { readonly "~standard": { readonly types?: { readonly input: infer I } } }
  ? unknown extends I
    ? unknown
    : I
  : unknown;
type ValidatedValue<S> = S extends { readonly "~standard": { readonly validate: (v: unknown) => infer R } }
  ? Extract<Awaited<R>, { readonly value: unknown }> extends { readonly value: infer V }
    ? V
    : unknown
  : unknown;
type SchemaOutput<S> = S extends { readonly "~standard": { readonly types?: { readonly output: infer O } } }
  ? unknown extends O
    ? ValidatedValue<S>
    : O
  : ValidatedValue<S>;

/**
 * A server function whose first argument is validated against `schema` before `impl` runs.
 * Invalid input is rejected with a 400 (`ServerFnError`, `data.issues`).
 * @example export const addTodo = serverFn(z.string().min(1), async (text) => save(text));
 */
export declare function serverFn<S extends StandardSchemaV1, R, Rest extends unknown[] = []>(
  schema: S,
  impl: (input: SchemaOutput<S>, ...rest: Rest) => R | Promise<R>,
): (input: SchemaInput<S>, ...rest: Rest) => Promise<Awaited<R>>;

/**
 * Throw from a server function to send `status` and `message` (and `data`) to the client.
 * Any other error becomes a generic 500 in production.
 */
export declare class ServerFnError extends Error {
  constructor(message: string, options?: { status?: number; data?: unknown });
  readonly status: number;
  readonly data?: unknown;
}

/**
 * `export const viewTransition = true` on a page route: client navigations to and from the page
 * run as View Transitions (`document.startViewTransition`), and full page loads between two such
 * pages get a cross-document one (`@view-transition { navigation: auto }`), also on pages that
 * ship no JS. Skipped when the browser lacks the API or the visitor prefers reduced motion. For a
 * single link, use `<Link viewTransition>` (or `data-nowaki-transition` on an `<a>`) instead, and
 * `transitionName()` from `@nowaki-dev/runtime/navigation` to morph an element into the next
 * page's. Off by default: a page without it gets nothing added to its HTML.
 * @example export const viewTransition = true;
 */
export type ViewTransition = boolean;

/**
 * `export const revalidate` on a page route: ISR. A render is cached for this many seconds (a
 * positive number) and re-rendered in the background once stale (`stale-while-revalidate`). Don't
 * put per-user data on such a page: Nowaki varies the cache by what the render read (cookies,
 * headers, the query), and a page that reads the session or cookies is never shared.
 * @example export const revalidate = 60;
 */
export type Revalidate = number;

/**
 * `export const scripts` on a page route or layout: modules shipped to the browser as
 * `<script type="module">`, bundled like an island but with no component and no hydration.
 * Read from the source at build time, so it must be an array of string literals: relative paths
 * (from the file that lists them) or package specifiers.
 * @example export const scripts = ["./hero.ts"];
 */
export type PageScripts = readonly string[];

/**
 * The exports a page route module (`routes/**\/*.tsx`, also `_404` / `_500`) may have, with their
 * types. Check one export with an indexed type, or the whole module from another file:
 * @example
 * export const revalidate: PageModule["revalidate"] = 60;
 * export const meta = { title: "Blog" } satisfies PageModule["meta"];
 * // routes.check.ts
 * import * as blog from "./routes/blog.tsx";
 * blog satisfies PageModule;
 */
export interface PageModule<D = any> {
  /** The page component. */
  default: (props: RouteProps<D>) => unknown;
  loader?: Loader<D>;
  action?: Action;
  meta?: Meta | MetaFn<D>;
  /** `<title>`. `meta.title` wins over it. */
  title?: string;
  /** Raw HTML put in `<head>` as written (no escaping: never build it from user input). */
  head?: string;
  /** `<html lang>`. With i18n it defaults to the request's locale. */
  lang?: string;
  htmlAttrs?: DocumentAttrs;
  bodyAttrs?: DocumentAttrs;
  revalidate?: Revalidate;
  tags?: RouteTags;
  streaming?: Streaming;
  csrf?: Csrf;
  budget?: RouteBudget;
  viewTransition?: ViewTransition;
  staticPaths?: StaticPaths;
  /** `false` leaves the page out of `nowaki prerender` / the static adapter. */
  prerender?: boolean;
  /** `false` leaves the page out of the generated sitemap.xml. */
  sitemap?: boolean;
  scripts?: PageScripts;
}

/** The exports a `_layout` module may have (a layout's `meta` applies to every page under it). */
export interface LayoutModule<D = any> {
  default: (props: LayoutProps<D>) => unknown;
  loader?: Loader<D>;
  meta?: Meta | MetaFn<D>;
  title?: string;
  head?: string;
  lang?: string;
  htmlAttrs?: DocumentAttrs;
  bodyAttrs?: DocumentAttrs;
  scripts?: PageScripts;
}

/**
 * The exports an API route (`routes/api/**`) or a file route (`feed.xml.ts`, `og/[card].png.ts`)
 * may have: one handler per request method (uppercase; a method without one gets 405 unless there
 * is a `default`), `csrf`, and for prerendered file routes `staticPaths` / `prerender`.
 */
export interface ApiModule {
  GET?: ApiHandler;
  POST?: ApiHandler;
  PUT?: ApiHandler;
  PATCH?: ApiHandler;
  DELETE?: ApiHandler;
  HEAD?: ApiHandler;
  OPTIONS?: ApiHandler;
  /** Handles every method without its own export. */
  default?: ApiHandler;
  csrf?: Csrf;
  staticPaths?: StaticPaths;
  prerender?: boolean;
}

/** A `_middleware` module: its default export runs before the routes under its directory. */
export interface MiddlewareModule {
  default: Middleware;
}

/** An island module (`islands/*.tsx`): the component, and `live` for a Jetstream island. */
export interface IslandModule<S = any> {
  default: (props: any) => unknown;
  live?: Live<S>;
}
