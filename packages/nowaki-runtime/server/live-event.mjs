// POST /__nowaki/live-event: one Jetstream event over plain HTTP, for servers without a WebSocket
// endpoint (deploy adapters) and clients whose socket can't connect. The client sends the island's
// current state + signature; the reply carries the new html, state, and signature. No node: imports
// (used on Edge too); the signing render is injected.

import { isCrossSite } from "./origin.mjs";

export const LIVE_EVENT_PATH = "/__nowaki/live-event";

const BODY_LIMIT = 64 * 1024;
const JSON_CT = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/// `live` is `{ lookup(name, version) -> island module | null, render }`, where `render` is
/// live.mjs `liveRender` (it verifies the signature before running any handler).
export async function dispatchLiveEvent(ctx, info, live) {
  if (ctx.method !== "POST") return errBody(405, "Method Not Allowed");
  // Same CSRF gate as server function RPC: JSON only (no simple request), a custom header (needs a
  // preflight we never grant), and no cross-site Origin / Sec-Fetch-Site.
  const ct = String(ctx.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (ct !== "application/json") return errBody(415, "Unsupported Media Type");
  if (ctx.get("x-nowaki-live") !== "1") return errBody(403, "Forbidden");
  if (isCrossSite((n) => ctx.get(n))) return errBody(403, "Forbidden");
  if (Number(ctx.get("content-length")) > BODY_LIMIT) return errBody(413, "Payload Too Large");

  let body = null;
  try {
    const text = await ctx.bodyText();
    if (text.length > BODY_LIMIT) return errBody(413, "Payload Too Large");
    body = JSON.parse(text);
  } catch {}
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name) return errBody(400, "Bad Request");
  const mod = await live.lookup(name, info.version);
  if (!mod) return errBody(404, "Not Found");
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
    if (err?.code === "NOWAKI_LIVE_SIG") return errBody(403, "Forbidden");
    if (err?.name === "LiveForbiddenError") return errBody(403, "forbidden");
    console.error(`[nowaki live] ${name} event failed:`, err);
    return errBody(500, "Internal Server Error");
  }
}

function errBody(status, message) {
  return { status, headers: JSON_CT, body: JSON.stringify({ error: message }) };
}
