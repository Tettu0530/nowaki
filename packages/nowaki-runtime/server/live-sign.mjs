// HMAC-signs and verifies live island state. State is embedded in the DOM and sent back on join,
// so without a signature anyone could forge arbitrary state (e.g. { isAdmin: true }).
// Verification runs in the same process as rendering, so the key is shared. It defaults to random
// per process; set NOWAKI_LIVE_SECRET to keep it stable across processes and restarts.
//
// A signature is `v1.<iat>.<mac>`: the issue time (unix seconds) is signed too, and signatures older
// than NOWAKI_LIVE_MAX_AGE seconds (default 86400) are rejected, so a captured state can't be
// replayed forever. Every patch is re-signed, so an active island never expires.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const env = globalThis.process?.env ?? {};
const MAX_AGE_S = positiveInt(env.NOWAKI_LIVE_MAX_AGE, 86400);
const CLOCK_SKEW_S = 60;

function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Created on first use, not at import (Workers can't generate random values at global scope).
let key = null;
function getKey() {
  if (!key) {
    key = env.NOWAKI_LIVE_SECRET ? Buffer.from(String(env.NOWAKI_LIVE_SECRET)) : randomBytes(32);
  }
  return key;
}

/// Production servers call this once when the app has live islands.
export function warnIfEphemeralLiveKey() {
  if (env.NOWAKI_LIVE_SECRET) return;
  console.warn(
    "[nowaki] NOWAKI_LIVE_SECRET is not set: live islands are signed with a random per-process key, " +
      "so their state can't resume after a restart or on another instance. Set it to a long random value.",
  );
}

// Key-order-independent stable serialization (still matches if serde_json re-serialization reorders keys).
// The state is signed as JSON will carry it: the client and Rust only ever see JSON.stringify(state),
// which drops undefined-valued keys and turns a Date (any toJSON) into its JSON form. Signing the raw
// object instead would make `{ ...state, error: undefined }` fail verification on the next event.
function canonical(v) {
  return stable(JSON.parse(JSON.stringify(v) ?? "null"));
}

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

const nowS = () => Math.floor(Date.now() / 1000);

// Signs the island name and issue time together with state (the name stops a sig being reused on another island).
function mac(name, iat, state) {
  return createHmac("sha256", getKey())
    .update(`${name} ${iat} ${canonical(state)}`)
    .digest("base64url");
}

export function sign(name, state, { now = nowS() } = {}) {
  return `v1.${now}.${mac(name, now, state)}`;
}

/// "ok", "expired" (a genuine signature past NOWAKI_LIVE_MAX_AGE: the page is just old), or
/// "invalid" (malformed, tampered, or dated in the future). The MAC is checked before the age, so
/// a forged signature with an old timestamp is "invalid", never "expired".
export function verifyStatus(name, state, sig, { now = nowS() } = {}) {
  if (typeof sig !== "string") return "invalid";
  const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]+)$/.exec(sig);
  if (!m) return "invalid";
  const iat = Number(m[1]);
  const expected = Buffer.from(mac(String(name), iat, state));
  const got = Buffer.from(m[2]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return "invalid";
  if (iat > now + CLOCK_SKEW_S) return "invalid";
  return now - iat > MAX_AGE_S ? "expired" : "ok";
}

export function verify(name, state, sig, opts) {
  return verifyStatus(name, state, sig, opts) === "ok";
}

// Shared by dev (render.mjs) and prod (app.mjs) so neither drifts by forgetting to sign.
export function liveProps(name, nid, state, topics) {
  const props = {
    name,
    nid,
    state: JSON.stringify(state),
    sig: sign(name, state),
    style: "display:contents",
  };
  // `live.subscribe` topics; the client sends them on join so publish(topic) can find the island.
  if (topics?.length) props.topics = JSON.stringify(topics);
  return props;
}
