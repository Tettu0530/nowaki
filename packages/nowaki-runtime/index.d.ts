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
  on: Record<string, (state: S, payload?: any) => S>;
}

/**
 * While a server function (`"use server"`) is running, returns that call's LoaderContext.
 * Returns null outside an RPC. Use it to read cookies/headers or for auth.
 */
export function getContext(): LoaderContext | null;
