// Public types for the Nowaki framework (getContext is also exported as a value).

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
  /** The request URL. */
  readonly url: URL;
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
  /** Reads an application/x-www-form-urlencoded body as URLSearchParams. */
  formData(): Promise<URLSearchParams>;
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

  /** Redirects (302 by default). Return it from a loader, action, or middleware. */
  redirect(to: string, status?: number): NowakiResult;
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
   * `nowaki start`); not shared across instances, and lost on restart.
   */
  room?: (props: any) => string;
  /** Initial shared state of a room (`live.room`). */
  shared?: (props?: any) => S;
}

/**
 * Refreshes every live island subscribed to `topic` (`live.subscribe`) by running its `live.load`
 * and pushing the patch. Call it from actions, server functions, or API routes after data changes.
 * Reaches connections in the same process under `nowaki dev` / `nowaki start`; a no-op on the
 * deploy adapters for now.
 */
export function publish(topic: string): void;

/**
 * While a server function (`"use server"`) or a live handler / `live.authorize` is running, returns
 * that call's LoaderContext (for live, the WebSocket upgrade's cookie, authorization,
 * accept-language, and user-agent headers). Returns null elsewhere. Use it for auth.
 */
export function getContext(): LoaderContext | null;

/**
 * The current locale with `i18n` in nowaki.config (`ctx.locale` of the request being rendered,
 * usable in components, layouts and islands). In the browser it is the page's locale. Undefined
 * without i18n, outside a page request, and in server functions.
 */
export function getLocale(): string | undefined;

/**
 * `path` in `locale` (default: the current locale): `localePath("/about", "ja")` → `"/ja/about"`,
 * `localePath("/ja/about", "en")` → `"/about"` when `en` is the default locale. The query and
 * fragment are kept. Returns `path` unchanged without i18n.
 */
export function localePath(path: string, locale?: string): string;

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
