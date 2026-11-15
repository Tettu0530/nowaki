# Sessions and environment variables

`ctx.session` keeps per-visitor values in an encrypted cookie, or server-side with a store.
`env.ts` declares the app's environment variables with a schema, so a missing or invalid one
stops the build and the server instead of failing on some request.

## Sessions

```ts
// routes/login.tsx (an action)
import type { LoaderContext } from "@nowaki-dev/runtime";
import { env } from "@nowaki-dev/runtime/env/server";

export async function action(ctx: LoaderContext) {
  const form = await ctx.formData();
  if (String(form.get("password") ?? "") !== env.ADMIN_PASSWORD) {
    ctx.status(401);
    return { error: true };
  }
  await ctx.session.regenerate(); // a new cookie on sign-in
  await ctx.session.set("user", "admin");
  return ctx.redirect("/account", 303);
}
```

```ts
// routes/(account)/_middleware.ts
import type { LoaderContext } from "@nowaki-dev/runtime";

export default async function requireUser(ctx: LoaderContext) {
  const user = await ctx.session.get<string>("user");
  if (!user) return ctx.redirect("/login");
  ctx.state.user = user;
}
```

| Method | |
| --- | --- |
| `get<T>(key)` | the value, or `undefined` |
| `has(key)` | whether it is set |
| `set(key, value)` | stores a JSON value (`undefined` deletes) |
| `delete(key)` | removes the key |
| `regenerate()` | a fresh cookie (and id, with a store), keeping the values. Call it on sign-in. |
| `destroy()` | clears the values and the cookie. Call it on sign-out. |
| `readOnly` | `true` where writes throw (see below) |

`ctx.session` is available in loaders, actions, middleware and API routes, as
`getContext().session` in server functions, and read-only in live islands. It is created on
first access, so requests that don't use it cost nothing.

Working examples: `examples/gallery/routes/login.tsx`, `logout.tsx`, `(account)/_middleware.ts`;
`examples/hello/routes/api/session.ts`.

### The secret

The cookie is encrypted (AES-256-GCM) or, with a store, signed (HMAC-SHA256), with keys derived
from `NOWAKI_SESSION_SECRET`.

- **Production refuses a session without it**: the first `ctx.session` access throws
  `[nowaki] session: NOWAKI_SESSION_SECRET is not set. ...`. Each entry must be at least 32
  characters.
- `nowaki dev` generates one into `.nowaki/session-secret`.
- To rotate keys, comma-separate several secrets. The first one is used for new cookies; the
  others still open existing ones.
- Declare it in `env.ts` so the server refuses to start without it, rather than failing on the
  first sign-in:

  ```ts
  server: { NOWAKI_SESSION_SECRET: z.string().min(32) }
  ```

Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.

### Options: `session.ts`

```ts
// session.ts (at the app root)
import { defineSession } from "@nowaki-dev/runtime/session";

export default defineSession({
  cookieName: "app_session", // default "nowaki_session"
  maxAge: 60 * 60 * 24 * 30, // seconds; default 7 days
  rolling: true,             // default: writes, and reads past half the lifetime, extend it
});
```

The cookie is `HttpOnly; SameSite=Lax; Path=/` (`Path=<basePath>` under a basePath), and
`Secure` over https. An unknown option or an invalid value throws at startup.

### Server-side store

The encrypted cookie holds at most 4 KB; a larger value throws on `set`. Keep an id in the
session and the record elsewhere, or give `session.ts` a `store`. The cookie then holds only a
random, signed id.

```ts
// session.ts
import { defineSession, type SessionStore, type StoredSession } from "@nowaki-dev/runtime/session";
import { redis } from "./lib/redis.ts"; // your client

const store: SessionStore = {
  async get(id) {
    const raw = await redis.get(`sess:${id}`);
    return raw ? (JSON.parse(raw) as StoredSession) : undefined;
  },
  async set(id, data, ttlSeconds) {
    await redis.set(`sess:${id}`, JSON.stringify(data), { EX: ttlSeconds });
  },
  async delete(id) {
    await redis.del(`sess:${id}`);
  },
};

export default defineSession({ store });
```

### Where a session can't be written

`readOnly` is `true`, and writes throw with a message saying why, in these cases:

- **A cross-site request that changes state** (POST / PUT / PATCH / DELETE from another
  origin). The session also reads as empty there, from middleware on. A route with
  `export const csrf = false` gets the real session.
- **Live island renders and handlers**: they can't set a cookie.

Writes also throw after the response headers were sent (the loaders of a
`streaming = "early"` page). A page that reads the session can't be prerendered: static output
fails naming the page.

### Sessions and caching

Reading the session makes the response per-visitor: an ISR page that reads it is never shared
from the cache. Keep ISR pages free of session reads, and check the session only where needed
(for writes, in middleware on non-GET requests). See [Caching](./caching.md).

Sessions use WebCrypto only and work on `nowaki start` and every server adapter. Static output
has no sessions.

## Environment variables and `.env`

The servers load `.env`, then `.env.local` over it, then the real environment over both. Only
`PUBLIC_*` variables (and `MODE`) are inlined into client code as `import.meta.env.PUBLIC_*`;
everything else stays on the server. Don't commit `.env` files with secrets.

## Typed env: `env.ts`

```ts
// env.ts (at the app root)
import { defineEnv } from "@nowaki-dev/runtime/env";
import { z } from "zod";

export default defineEnv({
  server: {
    DATABASE_URL: z.string().url(),
    NOWAKI_SESSION_SECRET: z.string().min(32),
    API_TOKEN: z.string().min(8).default("dev-token"),
  },
  public: {
    PUBLIC_SITE_NAME: z.string().default("Example"),
  },
});
```

```ts
// in a loader, action, API route or server function
import { env } from "@nowaki-dev/runtime/env/server";

const db = connect(env.DATABASE_URL); // a string, typed by `nowaki typegen`
```

```tsx
// in an island or a page: public values only
<h1>{import.meta.env.PUBLIC_SITE_NAME}</h1>
```

- Each variable has a Standard Schema (Zod, Valibot, ArkType). Public names must start with
  `PUBLIC_`; server names must not.
- **Validated before the build.** `nowaki build`, `dev` and `prerender` fail on a missing or
  invalid variable, naming it and never printing its value:
  `[nowaki] env: invalid environment (env.ts): DATABASE_URL: missing (...)`.
- **Validated again at startup.** `nowaki start` and the node, bun, deno and vercel adapters
  refuse to start; the Cloudflare Worker checks its vars and secrets before the first request and
  answers 500 until they are fixed. At startup only the `server` variables are checked: the
  `public` values are the ones the build inlined, so the server sees what the browser got.
  Changing a public value needs a new build.
- Read `env` inside a loader, action or handler: a read at module load, before validation,
  throws.
- **Server-only.** Importing `@nowaki-dev/runtime/env/server` from client code (an island, a page
  script) fails the build with the import chain.
- `nowaki typegen` (also run by `dev` and `build`) types `env` and `import.meta.env` from the
  schemas. The scaffold's `nowaki-env.d.ts` types any `PUBLIC_*` as `string | undefined`; a
  non-string public schema (`z.coerce.number()`) needs that index signature widened.
- `nowaki dev` reads env.ts and the `.env` files at startup; restart it after a change.

Working examples: `examples/hello/env.ts` and `routes/env.tsx`, `examples/gallery/env.ts`.

## Reference

- [Runtime API](../reference/runtime.md) (`Session`, `@nowaki-dev/runtime/session`,
  `@nowaki-dev/runtime/env`, `@nowaki-dev/runtime/env/server`)
- [Environment variables](../reference/env-vars.md) (`NOWAKI_SESSION_SECRET` and the others
  Nowaki reads)
- [File conventions](../reference/file-conventions.md) (`session.ts`, `env.ts`, `.env`)
