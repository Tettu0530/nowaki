// Sessions: `ctx.session` (context.mjs creates one on first access, so a request that never reads
// it pays nothing). WebCrypto only (no node: imports): the same code runs on Node, Bun, Deno and
// Workers.
//
// Cookie store (default): the cookie is `v1.<b64url(iv ‖ AES-256-GCM ciphertext)>` of
// `{ d, iat, exp }`, with a random 96-bit IV and `<cookieName>|v1` as additional data, so a cookie
// can't be moved to another cookie name. Store mode (`store` in session.ts): the cookie is
// `v1.<id>.<b64url(HMAC-SHA256(<cookieName>|v1|<id>))>` with a random 256-bit id; the data lives
// in the store. Both keys come from NOWAKI_SESSION_SECRET through HKDF-SHA256. Several secrets,
// comma-separated, rotate keys: the first one encrypts / signs, every one decrypts / verifies, and
// a cookie read with an older one is reissued with the first.

const VERSION = "v1";
const MAX_COOKIE = 4096;
const MIN_SECRET = 32;
const DEFAULTS = { cookieName: "nowaki_session", maxAge: 60 * 60 * 24 * 7, rolling: true, store: null };
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ID = /^[A-Za-z0-9_-]{43}$/;

const MISSING_SECRET =
  "[nowaki] session: NOWAKI_SESSION_SECRET is not set. Sessions encrypt and sign their cookie with it: set it to a random string of at least 32 characters (comma-separate several to rotate keys; the first one is used for new cookies). Declare it in env.ts so the server refuses to start without it.";

/// Options of the app root's `session.ts` (`export default defineSession({ ... })`), checked here so
/// a typo fails at startup rather than on some request.
export function defineSession(options = {}) {
  if (!options || typeof options !== "object") throw new Error("defineSession expects an options object");
  for (const k of Object.keys(options)) {
    if (!(k in DEFAULTS)) throw new Error(`defineSession: unknown option "${k}" (cookieName, maxAge, rolling, store)`);
  }
  const out = { ...DEFAULTS };
  if (options.cookieName !== undefined) {
    if (typeof options.cookieName !== "string" || !COOKIE_NAME.test(options.cookieName)) {
      throw new Error(`defineSession: cookieName must be a cookie name token, got ${JSON.stringify(options.cookieName)}`);
    }
    out.cookieName = options.cookieName;
  }
  if (options.maxAge !== undefined) {
    if (!Number.isInteger(options.maxAge) || options.maxAge <= 0) {
      throw new Error("defineSession: maxAge must be a positive whole number of seconds");
    }
    out.maxAge = options.maxAge;
  }
  if (options.rolling !== undefined) {
    if (typeof options.rolling !== "boolean") throw new Error("defineSession: rolling must be true or false");
    out.rolling = options.rolling;
  }
  if (options.store != null) {
    const s = options.store;
    if (typeof s !== "object" || ["get", "set", "delete"].some((m) => typeof s[m] !== "function")) {
      throw new Error("defineSession: store must have get(id), set(id, data, ttlSeconds) and delete(id)");
    }
    out.store = s;
  }
  return Object.freeze(out);
}

// What the server that loaded this module configured (app.mjs, web.mjs, the dev sidecar).
//   config    : defineSession() output of session.ts, or the defaults
//   secret()  : the raw NOWAKI_SESSION_SECRET (the dev sidecar falls back to .nowaki/session-secret)
//   prerender : pages are being written to files, where a per-visitor session can't exist
let settings = { config: DEFAULTS, secret: () => globalThis.process?.env?.NOWAKI_SESSION_SECRET, prerender: false };

export function configureSessions({ config, secret, prerender } = {}) {
  settings = {
    config: config ? sessionConfigOf(config) : DEFAULTS,
    secret: secret ?? (() => globalThis.process?.env?.NOWAKI_SESSION_SECRET),
    prerender: prerender === true,
  };
}

/// The config an imported session.ts module default-exports.
export function sessionConfigOf(mod) {
  const def = mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
  if (!def || typeof def !== "object" || !("cookieName" in def)) {
    throw new Error("session.ts must `export default defineSession({ ... })` (from @nowaki-dev/runtime/session)");
  }
  return def;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) return null;
  try {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const b64len = (n) => Math.ceil((n * 4) / 3);

// Derived keys per secret string, computed once per process.
const keyCache = new Map();
function keysFor(raw) {
  let p = keyCache.get(raw);
  if (!p) {
    const secrets = raw.split(",").map((s) => s.trim()).filter(Boolean);
    p = Promise.all(secrets.map(deriveKeys));
    keyCache.set(raw, p);
  }
  return p;
}

async function deriveKeys(secret) {
  const subtle = globalThis.crypto.subtle;
  const ikm = await subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  const hkdf = (info) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) });
  const [aes, mac] = await Promise.all([
    subtle.deriveKey(hkdf("nowaki-session-v1"), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    subtle.deriveKey(hkdf("nowaki-session-v1 id"), ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]),
  ]);
  return { aes, mac };
}

function checkSecret(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(MISSING_SECRET);
  for (const s of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (s.length < MIN_SECRET) {
      throw new Error(`[nowaki] session: every NOWAKI_SESSION_SECRET entry must be at least ${MIN_SECRET} characters (one has ${s.length})`);
    }
  }
}

/// Encrypts a cookie-store payload with the first key. Exported for tests.
export async function sealCookie(raw, cookieName, payload) {
  const [{ aes }] = await keysFor(raw);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(`${cookieName}|${VERSION}`) },
      aes,
      enc.encode(JSON.stringify(payload)),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `${VERSION}.${b64url(out)}`;
}

/// `{ payload, keyIndex }` for a cookie any key opens, else null. Exported for tests.
export async function openCookie(raw, cookieName, value) {
  if (typeof value !== "string" || !value.startsWith(`${VERSION}.`) || value.length > MAX_COOKIE) return null;
  const bytes = fromB64url(value.slice(VERSION.length + 1));
  if (!bytes || bytes.length < 12 + 16 + 2) return null;
  const iv = bytes.subarray(0, 12);
  const ct = bytes.subarray(12);
  const aad = enc.encode(`${cookieName}|${VERSION}`);
  const keys = await keysFor(raw);
  for (let i = 0; i < keys.length; i++) {
    let plain;
    try {
      plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, keys[i].aes, ct);
    } catch {
      continue; // not this key (or tampered: every key fails)
    }
    const payload = envelope(safeJson(dec.decode(plain)));
    return payload ? { payload, keyIndex: i } : null;
  }
  return null;
}

async function signId(raw, cookieName, id) {
  const [{ mac }] = await keysFor(raw);
  const sig = await globalThis.crypto.subtle.sign("HMAC", mac, enc.encode(`${cookieName}|${VERSION}|${id}`));
  return `${VERSION}.${id}.${b64url(new Uint8Array(sig))}`;
}

async function verifyId(raw, cookieName, value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !ID.test(parts[1])) return null;
  const sig = fromB64url(parts[2]);
  if (!sig || sig.length !== 32) return null;
  const data = enc.encode(`${cookieName}|${VERSION}|${parts[1]}`);
  const keys = await keysFor(raw);
  for (let i = 0; i < keys.length; i++) {
    // subtle.verify compares in constant time.
    if (await globalThis.crypto.subtle.verify("HMAC", keys[i].mac, sig, data)) return { id: parts[1], keyIndex: i };
  }
  return null;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function envelope(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (!p.d || typeof p.d !== "object" || Array.isArray(p.d)) return null;
  if (!Number.isFinite(p.iat) || !Number.isFinite(p.exp)) return null;
  return p;
}

const now = () => Math.floor(Date.now() / 1000);
const newId = () => b64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const READ_ONLY = {
  crossSite:
    "ctx.session is read-only on a cross-site request that changes state (CSRF): it reads as empty and can't be changed. Submit from your own site, or add `export const csrf = false` to the route to opt out.",
  live: "ctx.session is read-only in live island renders: they can't set a cookie. Change the session in an action, API route, or server function.",
};
const AFTER_COMMIT =
  'ctx.session changed after the response headers were built (a `streaming = "early"` page\'s loaders run after the shell is sent). Change the session in an action, middleware, API route, or server function.';

/// The `ctx.session` of one request. `mode`: undefined, "crossSite" (empty, read-only) or "live"
/// (read-only). Throws when sessions can't work here (no secret in production, prerendering).
export function createSession(ctx, mode) {
  if (settings.prerender) {
    throw new Error("[nowaki] ctx.session can't be used in a prerendered page: the page is one static file for every visitor. Read the session in an API route or a server-rendered page.");
  }
  const raw = settings.secret();
  checkSecret(raw);
  const { cookieName, maxAge, rolling, store } = settings.config;
  const readOnly = mode !== undefined;

  let data = new Map();
  let iat = 0;
  let exp = 0;
  let id; // store mode: the current id, if the request came with a valid one
  let hadCookie = false;
  let dirty = false; // data changed
  let reissue = false; // same data, new cookie (key rotation, rolling refresh, regenerate)
  let committed = false;
  const stale = []; // store ids to delete
  let loading = null;

  const load = () => (loading ??= readIncoming());

  async function readIncoming() {
    if (mode === "crossSite") return;
    const value = ctx.cookies[cookieName];
    if (value === undefined) return;
    hadCookie = true;
    let payload;
    let keyIndex;
    if (store) {
      const v = await verifyId(raw, cookieName, value);
      if (!v) return;
      payload = envelope(await store.get(v.id));
      if (!payload) return;
      id = v.id;
      keyIndex = v.keyIndex;
    } else {
      const opened = await openCookie(raw, cookieName, value);
      if (!opened) return;
      ({ payload, keyIndex } = opened);
    }
    const t = now();
    if (payload.exp <= t) return;
    for (const [k, v] of Object.entries(payload.d)) data.set(k, v);
    iat = payload.iat;
    exp = payload.exp;
    if (keyIndex > 0) markReissue();
    if (rolling && exp - t < maxAge / 2) markReissue();
  }

  function markReissue() {
    reissue = true;
    if (!readOnly) ctx.__commit = commit;
  }

  function writable() {
    if (readOnly) throw new Error(READ_ONLY[mode]);
    if (committed || ctx.__sent) throw new Error(AFTER_COMMIT);
  }

  function changed() {
    dirty = true;
    ctx.__commit = commit;
  }

  const secure = () => ctx.url.protocol === "https:";
  const cookieOpts = (age) => ({ maxAge: age, path: "/", httpOnly: true, secure: secure(), sameSite: "Lax" });

  // Cookie-store only: the cookie for `data` must fit the browser limit (name=value ≤ 4096 bytes).
  function checkSize() {
    if (store) return;
    const json = enc.encode(JSON.stringify({ d: Object.fromEntries(data), iat: 1e10, exp: 1e10 })).length;
    const size = cookieName.length + 1 + VERSION.length + 1 + b64len(12 + json + 16);
    if (size > MAX_COOKIE) {
      throw new Error(`[nowaki] session: the session cookie would be ${size} bytes, over the ${MAX_COOKIE}-byte cookie limit. Keep less in the session (an id, not the record), or set a store in session.ts.`);
    }
  }

  async function commit() {
    committed = true;
    if (!dirty && !reissue) return;
    const t = now();
    for (const old of stale) await store.delete(old);
    if (data.size === 0) {
      // Nothing left to keep: drop the cookie (and the stored record) instead of sending an empty one.
      if (id !== undefined) await store.delete(id);
      if (hadCookie) ctx.deleteCookie(cookieName, cookieOpts(0));
      return;
    }
    if (!iat) iat = t;
    exp = rolling ? t + maxAge : iat + maxAge;
    const age = exp - t;
    if (age <= 0) {
      if (hadCookie) ctx.deleteCookie(cookieName, cookieOpts(0));
      return;
    }
    const payload = { d: Object.fromEntries(data), iat, exp };
    let value;
    if (store) {
      if (id === undefined) id = newId();
      await store.set(id, payload, age);
      value = await signId(raw, cookieName, id);
    } else {
      value = await sealCookie(raw, cookieName, payload);
      if (cookieName.length + 1 + value.length > MAX_COOKIE) {
        throw new Error(`[nowaki] session: the session cookie is ${cookieName.length + 1 + value.length} bytes, over the ${MAX_COOKIE}-byte cookie limit. Keep less in the session, or set a store in session.ts.`);
      }
    }
    ctx.setCookie(cookieName, value, cookieOpts(age));
  }

  const session = {
    get readOnly() {
      return readOnly;
    },
    async get(key) {
      await load();
      return data.get(String(key));
    },
    async has(key) {
      await load();
      return data.has(String(key));
    },
    async set(key, value) {
      writable();
      await load();
      writable();
      const k = String(key);
      if (value === undefined) return session.delete(k);
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error(`[nowaki] session: the value of "${k}" isn't JSON (sessions keep JSON values)`);
      const prev = data.has(k) ? { v: data.get(k) } : null;
      data.set(k, JSON.parse(json));
      try {
        checkSize();
      } catch (err) {
        if (prev) data.set(k, prev.v);
        else data.delete(k);
        throw err;
      }
      changed();
    },
    async delete(key) {
      writable();
      await load();
      writable();
      if (data.delete(String(key))) changed();
    },
    /// New id (store mode) and a fresh cookie, keeping the data: call it on sign-in so a session
    /// id planted before the sign-in is worthless after it.
    async regenerate() {
      writable();
      await load();
      writable();
      if (id !== undefined) stale.push(id);
      id = undefined;
      iat = now();
      changed();
    },
    /// Clears the session and its cookie (sign-out).
    async destroy() {
      writable();
      await load();
      writable();
      if (id !== undefined) stale.push(id);
      id = undefined;
      data = new Map();
      changed();
    },
  };
  return session;
}
