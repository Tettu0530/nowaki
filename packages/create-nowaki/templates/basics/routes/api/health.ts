// Example API route (server-only). No secrets in responses; validate inputs on real endpoints.
// `ApiModule` types every export an API route can have (GET, POST, ..., csrf).
import type { ApiModule } from "@nowaki-dev/runtime";

export const GET: ApiModule["GET"] = (ctx) => ctx.json({ ok: true });
