// POST /__nowaki/live-event: one Jetstream event over plain HTTP, for servers without a WebSocket
// endpoint (deploy adapters) and clients whose socket can't connect. The client sends the island's
// current state + signature; the reply carries the new html, state, and signature. No node: imports
// (used on Edge too); the signing render is injected.

import { isCrossSite } from "./origin.mjs";
import { logError } from "./log.mjs";

export const LIVE_EVENT_PATH = "/__nowaki/live-event";

const BODY_LIMIT = 64 * 1024;
const JSON_CT = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/// Whether NOWAKI_LIVE_SECRET is set (read on each call: a Worker's vars reach process.env).
export function liveSecretSet() {
  const s = globalThis.process?.env?.NOWAKI_LIVE_SECRET;
  return typeof s === "string" && s !== "";
}

let refusedLogged = false;

/// `live` is `{ lookup(name, version) -> island module | null, render, requireSecret? }`, where
/// `render` is live.mjs `liveRender` (it verifies the signature before running any handler).
/// `requireSecret` (the cloudflare and vercel adapters): without NOWAKI_LIVE_SECRET each instance
/// signs with its own random key, so events fail at random depending on which instance answers;
/// such a server answers every event 503 instead, logged once (pages still render).
export async function dispatchLiveEvent(ctx, info, live) {
  if (ctx.method !== "POST") return errBody(405, "Method Not Allowed");
  // Same CSRF gate as server function RPC: JSON only (no simple request), a custom header (needs a
  // preflight, which is never granted), and no cross-site Origin / Sec-Fetch-Site.
  const ct = String(ctx.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (ct !== "application/json") return errBody(415, "Unsupported Media Type");
  if (ctx.get("x-nowaki-live") !== "1") return errBody(403, "Forbidden");
  if (isCrossSite((n) => ctx.get(n))) return errBody(403, "Forbidden");
  if (live.requireSecret && !liveSecretSet()) {
    if (!refusedLogged) {
      refusedLogged = true;
      logError(
        "live events are refused (503): NOWAKI_LIVE_SECRET is not set. On this adapter every instance " +
          "would sign live state with its own random key; set NOWAKI_LIVE_SECRET to a long random value.",
        undefined,
        { scope: "live" },
      );
    }
    return errBody(503, "Service Unavailable");
  }
  if (Number(ctx.get("content-length")) > BODY_LIMIT) return errBody(413, "Payload Too Large");

  let text = "";
  try {
    // Capped while streaming (a chunked body has no Content-Length to check above).
    text = await ctx.__bodyText(BODY_LIMIT);
  } catch (err) {
    // Over the body limit while reading: 413, not 400.
    if (err?.name === "RequestBodyError") return errBody(err.status, err.status === 413 ? "Payload Too Large" : "Bad Request");
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name) return errBody(400, "Bad Request");
  const mod = await live.lookup(name, info.version);
  if (!mod) return errBody(404, "Not Found");
  const tok = ctx.__trace?.begin(null, `live ${name}`);
  try {
    const { html, state, sig } = await live.render(
      mod,
      body.state ?? {},
      typeof body.handler === "string" ? body.handler : null,
      body.payload ?? null,
      name,
      body.sig,
    );
    return { status: 200, headers: JSON_CT, body: JSON.stringify({ html, state, sig }) };
  } catch (err) {
    if (err?.code === "NOWAKI_LIVE_STALE") return errBody(409, "stale");
    if (err?.code === "NOWAKI_LIVE_SIG") return errBody(403, "Forbidden");
    if (err?.name === "LiveForbiddenError") return errBody(403, "forbidden");
    logError(`${name} event failed:`, err, { scope: "live", trace: ctx.__trace });
    return errBody(500, "Internal Server Error");
  } finally {
    ctx.__trace?.end(tok);
  }
}

function errBody(status, message) {
  return { status, headers: JSON_CT, body: JSON.stringify({ error: message }) };
}
