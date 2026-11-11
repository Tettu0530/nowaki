// GET /__nowaki/health: a liveness answer with no data in it, never cached. The node / bun / deno
// app and the worker answer it before routing; `nowaki start` answers it in Rust (start.rs
// `health`, which pings the sidecar's own copy of it).

export const HEALTH_PATH = "/__nowaki/health";

export const HEALTH_BODY = '{"status":"ok"}';

export const HEALTH_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export const isHealth = (method, pathname) => pathname === HEALTH_PATH && (method === "GET" || method === "HEAD");
