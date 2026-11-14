// Types for `@nowaki-dev/runtime/session`: the options in the app root's session.ts.

/** What a store keeps per session id. */
export interface StoredSession {
  /** The values. */
  d: Record<string, unknown>;
  /** When the session was issued (Unix seconds). */
  iat: number;
  /** When it expires (Unix seconds). */
  exp: number;
}

/**
 * Where store-mode sessions keep their data. The cookie then holds only a random, signed id.
 * `ttlSeconds` is how long the record must live; drop it after that (the session also checks its
 * own expiry, so a store that ignores the TTL only keeps dead records around).
 */
export interface SessionStore {
  /** The record of `id`, or undefined / null when there is none. */
  get(id: string): StoredSession | undefined | null | Promise<StoredSession | undefined | null>;
  /** Stores the record of `id`, to keep for `ttlSeconds`. */
  set(id: string, data: StoredSession, ttlSeconds: number): void | Promise<void>;
  /** Removes the record of `id`. */
  delete(id: string): void | Promise<void>;
}

/** The options of {@link defineSession}. */
export interface SessionOptions {
  /** Cookie name. Default `"nowaki_session"`. */
  cookieName?: string;
  /** Lifetime in seconds. Default 7 days. */
  maxAge?: number;
  /**
   * `true` (default): each write, and a read past half the lifetime, extends the session by
   * `maxAge`. `false`: the session ends `maxAge` after sign-in (`regenerate()`) or creation.
   */
  rolling?: boolean;
  /** Keeps the data server-side instead of in the encrypted cookie (which is limited to 4 KB). */
  store?: SessionStore;
}

/** The options with the defaults filled in, as `defineSession` returns them. */
export interface SessionConfig extends Readonly<Required<Omit<SessionOptions, "store">>> {
  readonly store: SessionStore | null;
}

/**
 * Session options, in the app root's `session.ts`. Without the file, `ctx.session` uses the
 * defaults. The cookie is encrypted (or, with a store, signed) with keys derived from
 * `NOWAKI_SESSION_SECRET`; production refuses to use a session without it. Throws on an unknown
 * option or an invalid value.
 * @example
 * // session.ts
 * import { defineSession } from "@nowaki-dev/runtime/session";
 * export default defineSession({ maxAge: 60 * 60 * 24 * 30 });
 */
export function defineSession(options?: SessionOptions): SessionConfig;
