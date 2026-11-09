/** What a store keeps per session id: the values, and when the session was issued and expires (Unix seconds). */
export interface StoredSession {
  d: Record<string, unknown>;
  iat: number;
  exp: number;
}

/**
 * Where store-mode sessions keep their data. The cookie then holds only a random, signed id.
 * `ttlSeconds` is how long the record must live; drop it after that (the session also checks its
 * own expiry, so a store that ignores the TTL only keeps dead records around).
 */
export interface SessionStore {
  get(id: string): StoredSession | undefined | null | Promise<StoredSession | undefined | null>;
  set(id: string, data: StoredSession, ttlSeconds: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
}

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
  /** Keep the data server-side instead of in the encrypted cookie (which is limited to 4 KB). */
  store?: SessionStore;
}

export interface SessionConfig extends Readonly<Required<Omit<SessionOptions, "store">>> {
  readonly store: SessionStore | null;
}

/**
 * Session options, in the app root's `session.ts`. Without the file, `ctx.session` uses the
 * defaults. The cookie is encrypted (or, with a store, signed) with keys derived from
 * `NOWAKI_SESSION_SECRET`; production refuses to use a session without it.
 * @example
 * // session.ts
 * import { defineSession } from "@nowaki-dev/runtime/session";
 * export default defineSession({ maxAge: 60 * 60 * 24 * 30 });
 */
export function defineSession(options?: SessionOptions): SessionConfig;
