// Dispatch for server functions (`"use server"`). Looks up the id from `POST /__nowaki/fn`'s `{ id, args }`
// in the allowlist and runs it inside an AsyncLocalStorage where `getContext()` works.
//
// Security: only ids in the allowlist (= exports of `"use server"` modules) are callable.
// A client can't call arbitrary functions by naming a module/export.

import { AsyncLocalStorage } from "node:async_hooks";

export const SERVER_FN_PATH = "/__nowaki/fn";

const JSON_CT = { "content-type": "application/json; charset=utf-8" };

const als = new AsyncLocalStorage();

/// Called inside a server function, returns that call's LoaderContext (null otherwise).
/// E.g. for auth or reading cookies.`import { getContext } from "@nowaki-dev/runtime/server/functions.mjs"`
export function getContext() {
  return als.getStore() ?? null;
}

/// Handles `/__nowaki/fn`. `sf` is `{ lookup(id, version), importModule(module, version) }`.
/// Each entry point (dev/prod/edge) provides its own sf for its environment.
export async function dispatchServerFn(ctx, info, sf) {
  if (ctx.method !== "POST") {
    return errBody(405, "Method Not Allowed");
  }
  // CSRF defense. Three layers against calls from cross-origin pages carrying the victim's cookies:
  //  (1) Content-Type must be application/json (rules out "simple requests" like text/plain)
  //  (2) custom header x-nowaki-rpc required (needs a preflight, which fails since we grant no CORS)
  //  (3) if Origin is present, only the same origin as Host is allowed
  // A substring match would miss `multipart/form-data; boundary=application/json`, so
  // match the media type before `;` exactly.
  const ct = String(ctx.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (ct !== "application/json") {
    return errBody(415, "Unsupported Media Type");
  }
  if (ctx.get("x-nowaki-rpc") !== "1") {
    return errBody(403, "Forbidden");
  }
  // The Rust front strips Host when proxying, so prefer x-forwarded-host for the original browser Host.
  // With neither, there's nothing to compare, so skip the Origin check and rely on the rpc header + JSON requirement above.
  const origin = ctx.get("origin");
  const host = ctx.get("x-forwarded-host") ?? ctx.get("host");
  if (origin && host && !sameOrigin(origin, host)) {
    return errBody(403, "cross-origin request forbidden");
  }
  let payload = null;
  try {
    payload = await ctx.bodyJson();
  } catch {
    payload = null;
  }
  const id = payload && typeof payload.id === "string" ? payload.id : null;
  const args = payload && Array.isArray(payload.args) ? payload.args : [];
  if (!id) {
    return errBody(400, "Bad Request: missing id");
  }
  const entry = await sf.lookup(id, info.version);
  if (!entry) {
    return errBody(404, "unknown server function");
  }
  try {
    const mod = await sf.importModule(entry.module, info.version);
    const fn = mod[entry.export];
    if (typeof fn !== "function") {
      return errBody(500, `server function is not a function: ${entry.export}`);
    }
    const result = await als.run(ctx, () => fn(...args));
    return {
      status: 200,
      headers: JSON_CT,
      body: JSON.stringify({ result: result === undefined ? null : result }),
    };
  } catch (err) {
    // Don't leak implementation details (stack) to the client. message only.
    return errBody(500, String(err?.message ?? err));
  }
}

function errBody(status, message) {
  return { status, headers: JSON_CT, body: JSON.stringify({ error: message }) };
}

function sameOrigin(origin, host) {
  if (!host) return false;
  const i = origin.indexOf("://");
  const originHost = i >= 0 ? origin.slice(i + 3).replace(/\/$/, "") : origin;
  return originHost === host;
}
