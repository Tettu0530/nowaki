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
  /** Route params (catch-all values are arrays). */
  readonly params: RouteParams;
  /** The HTTP method. */
  readonly method: string;
  /** Request headers (lowercase keys). */
  readonly headers: Record<string, string>;
  /** Parsed request cookies. */
  readonly cookies: Record<string, string>;
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
 * or the static adapter, one page per entry. A `[...rest]` param takes a string[].
 * @example export const staticPaths: StaticPaths = [{ slug: "hello" }, { slug: "world" }];
 */
export type StaticPaths<P extends RouteParams = RouteParams> = P[] | (() => P[] | Promise<P[]>);

/**
 * `export const budget` on a page route: the most first-load client JS the page may ship, in KB of
 * gzip (the islands runtime, the islands it can render, and the live runtime). `nowaki build`
 * fails when the page goes over it. `js` must be a number literal; `0` means no client JS.
 * @example export const budget = { js: 12 };
 */
export type RouteBudget = { js: number };

/** API route handler (per-method export or default). */
export type ApiHandler = (
  ctx: LoaderContext,
) => Response | NowakiResult | unknown | Promise<Response | NowakiResult | unknown>;

/** Middleware. Returning a Response/redirect short-circuits the request. */
export type Middleware = (ctx: LoaderContext) => unknown | Promise<unknown>;

/** Page metadata (`<title>` / `<head>` / `<html lang>`). */
export interface Meta {
  title?: string;
  head?: string;
  lang?: string;
}

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
