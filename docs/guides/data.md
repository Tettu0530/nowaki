# Data: loaders, actions, API routes and server functions

Nowaki has four ways to run code on the server for a request:

| | Runs | Use it for |
| --- | --- | --- |
| `loader` | before a page or layout renders (GET and every other method) | reading data for the HTML |
| `action` | on POST / PUT / PATCH / DELETE to a page | HTML forms (Post/Redirect/Get) |
| API route | on a request to `routes/api/**` or a file route | JSON endpoints, webhooks, files |
| server function | when client code calls an export of a `"use server"` module | calls from islands without writing an endpoint |

All of them receive or can reach the same request context, `LoaderContext` (`ctx`), with the
URL, params, headers, cookies, the session, the body readers and the response writers.

## Loaders

A `loader` export runs on the server before the page renders. Its return value is the page's
`data` prop. `PageProps<typeof loader>` infers the type.

```tsx
// routes/blog/[slug].tsx
import type { LoaderContext, PageProps } from "@nowaki-dev/runtime";

export async function loader(ctx: LoaderContext) {
  const post = await db.post(String(ctx.params.slug)); // your data layer
  if (!post) ctx.status(404);
  return { post };
}

export default function Post({ data }: PageProps<typeof loader>) {
  return data.post ? <h1>{data.post.title}</h1> : <h1>Not found</h1>;
}
```

- The loader's code and imports stay on the server. Only the rendered HTML (and the props of
  the islands it renders) reach the browser.
- Return `ctx.redirect("/login")` (or any `ctx.json` / `html` / `text` result, or a
  `Response`) to answer with that instead of the page. `PageProps<typeof loader>` leaves those
  results out of `data`: the page only ever gets the data.
- `ctx.status(code)`, `ctx.setHeader(name, value)` and `ctx.setCookie(name, value, opts)` set
  the page response's status, headers and cookies.
- A layout can have a loader too; its data goes to the layout's `data` prop (see
  [Layouts and middleware](./layouts-and-middleware.md)).
- A loader that throws renders `_500.tsx` (or the built-in error page) with status 500.
- In a loader, read the request from `ctx`. `getContext()` returns `null` there (it covers
  actions, API routes, server functions and live handlers).

Working examples: `examples/hello/routes/todos.tsx`, `examples/gallery/routes/posts/[id].tsx`.

### What a loader reads decides caching

On an ISR page (`export const revalidate`), Nowaki records what the render reads: a header or
cookie read becomes part of the cache key, and a page that reads the session or cookies is never
shared between visitors. See [Caching](./caching.md).

### Streaming

`export const streaming = true` sends the document shell once the loaders resolve and streams
the body as it renders (Suspense boundaries arrive as they settle). A loader redirect or error
still sets the status.

`export const streaming = "early"` sends the shell before any loader runs, so the first byte
doesn't wait for data. The status and headers are then fixed:

- `meta` sees only the static `title` / `head` exports,
- a loader redirect becomes a client-side `location.replace` (only to `http(s)` URLs),
- a loader error renders the nearest `error.tsx` inside the page,
- cookies set by a loader are not sent, and `ctx.session` can't be changed,
- the page is never stored in an ISR cache.

Working examples: `examples/hello/routes/stream.tsx`, `examples/hello/routes/stream-early.tsx`.

## Actions

An `action` export runs for every method but GET, HEAD and OPTIONS. A plain HTML form posts to
the page it's on, so a form needs no JavaScript.

```tsx
// routes/todos.tsx
import type { LoaderContext, PageProps } from "@nowaki-dev/runtime";

export function loader(ctx: LoaderContext) {
  return { todos: JSON.parse(ctx.cookies.todos ?? "[]") as string[] };
}

export async function action(ctx: LoaderContext) {
  const form = await ctx.formData();
  const text = String(form.get("text") ?? "").trim();
  if (!text) {
    ctx.status(400);
    return { error: "Write something first." };
  }
  const todos = [...JSON.parse(ctx.cookies.todos ?? "[]"), text];
  ctx.setCookie("todos", JSON.stringify(todos));
  return ctx.redirect("/todos", 303);
}

export default function Todos({ data, actionData }: PageProps<typeof loader>) {
  const error = (actionData as { error?: string } | undefined)?.error;
  return (
    <main>
      <form method="post">
        <input name="text" />
        <button type="submit">Add</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <ul>{data.todos.map((t) => <li>{t}</li>)}</ul>
    </main>
  );
}
```

- Return a redirect (Post/Redirect/Get) or another response to send it.
- Return anything else and the page re-renders: the loader runs again and the value arrives as
  the `actionData` prop, with the status the action set.
- A cross-site POST / PUT / PATCH / DELETE is rejected with 403 before the action runs. See
  [Security](./security.md#cross-site-writes-csrf).
- A POST to a page without an `action` renders the page as for a GET.

Working examples: `examples/hello/routes/todos.tsx`, `examples/gallery/routes/login.tsx`.

## Reading the request body

`ctx.formData()` reads `application/x-www-form-urlencoded` and `multipart/form-data` bodies and
returns a `FormData`, as the platform `Request.formData()` does. Text fields are strings, file
parts are `File`.

```ts
// routes/api/upload.ts
import type { LoaderContext } from "@nowaki-dev/runtime";

export async function POST(ctx: LoaderContext) {
  const form = await ctx.formData();
  const file = form.get("file");
  const note = String(form.get("note") ?? "");
  if (!(file instanceof File)) return ctx.json({ error: "no file" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return ctx.json({ size: bytes.length, type: file.type, note });
}
```

- `form.get("x")` is `string | File | null`. Read text with `String(form.get("x") ?? "")`.
- **`File.name` is untrusted.** It may contain `../`, CR or LF. Never use it as a path or put
  it in a header without sanitizing it.
- `ctx.bodyText()` reads the body as a string, `ctx.bodyJson()` as JSON (`null` for an empty
  body). The body is read once; a second call returns the same content.

### Body limits

| What | Limit | Setting |
| --- | --- | --- |
| `ctx.formData()`, `ctx.bodyText()`, `ctx.bodyJson()` | 10 MiB | `NOWAKI_FORM_BODY_LIMIT` (bytes) |
| Server function calls | 1 MiB, at most 16 arguments | `NOWAKI_FN_BODY_LIMIT` (bytes) |
| Jetstream POST events, `POST /__nowaki/revalidate` | 64 KiB | fixed |

- A `Content-Length` over the limit is answered with **413 Payload Too Large** before the body
  is read. A body without `Content-Length` (chunked) is read up to the limit; on Node, going over
  it may reset the connection before a 413 can be sent.
- A malformed body (a bad multipart boundary, invalid JSON) is a **400**. In dev the response
  says why; in production it is "Bad Request". On an API route the error body is JSON.
- `nowaki dev` and `nowaki start` also cap the body they forward to the renderer: 16 MiB, or
  `NOWAKI_FORM_BODY_LIMIT` when that is larger. Raise `NOWAKI_FORM_BODY_LIMIT` for larger
  uploads.
- The hosting platform may have a lower request size limit of its own (Vercel functions,
  Cloudflare Workers): that one applies first.

## API routes

API routes live under `routes/api/`. Each exports handlers named after the HTTP method, in
uppercase (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`), or a `default` handler
for every method without its own export. A method without a handler gets
`405 {"error":"Method Not Allowed"}`.

```ts
// routes/api/todos.ts
import type { LoaderContext } from "@nowaki-dev/runtime";

export async function GET(ctx: LoaderContext) {
  return ctx.json(await db.todos()); // your data layer
}

export async function POST(ctx: LoaderContext) {
  const body = await ctx.bodyJson<{ text?: unknown }>();
  if (typeof body?.text !== "string") return ctx.json({ error: "text is required" }, { status: 400 });
  return ctx.json(await db.addTodo(body.text), { status: 201 });
}
```

A handler may return:

- a `ctx.json(data, init)`, `ctx.text(s, init)`, `ctx.html(markup, init)` or `ctx.redirect(to)`
  result,
- a `Response` (sent as it is, streams included; see `examples/hello/routes/api/stream.ts`),
- an object with a `status`, `headers` or `body` key, sent as that response (a string `body`
  as-is, anything else as JSON),
- any other value, sent as JSON with status 200.

Because of the third rule, a plain data object that happens to have a `status` or `body` key
is read as a response shape. Wrap such data in `ctx.json(...)`.

Method exports are uppercase only. A lowercase export (`export function get`) fails every
request to the route with an error naming the uppercase name.

**Cross-site writes are rejected.** A POST / PUT / PATCH / DELETE whose `Origin` is another site
(or `null`), or with `Sec-Fetch-Site: cross-site`, gets 403 before the handler runs. Requests
without either header (curl, server-to-server calls) pass. For a webhook or another endpoint
that other sites call, export `csrf = false` and authenticate the caller another way:

```ts
// routes/api/webhook.ts
import type { LoaderContext } from "@nowaki-dev/runtime";

export const csrf = false;

export async function POST(ctx: LoaderContext) {
  if (!(await verifySignature(ctx.get("x-signature"), await ctx.bodyText()))) {
    return ctx.text("bad signature", { status: 401 });
  }
  return ctx.json({ ok: true });
}
```

Working examples: `examples/hello/routes/api/` (`echo.ts`, `upload.ts`, `session.ts`,
`stream.ts`, `webhook.ts`).

## Server functions

A module whose first statement is `"use server"` is a set of server functions. Client code that
imports it gets a small fetch proxy per export; the implementation, its imports and its secrets
stay on the server.

```ts
// actions/todos.ts
"use server";
import { z } from "zod";
import { getContext, serverFn, ServerFnError } from "@nowaki-dev/runtime";

const store: string[] = [];

export async function listTodos(): Promise<string[]> {
  return store.slice();
}

export const addTodo = serverFn(z.string().trim().min(1).max(200), async (text) => {
  const user = await getContext()?.session.get<string>("user");
  if (!user) throw new ServerFnError("Sign in first", { status: 401 });
  store.push(text);
  return store.slice();
});
```

```tsx
// islands/Todos.tsx
import { useState } from "preact/hooks";
import { addTodo } from "../actions/todos.ts";

export default function Todos({ initial }: { initial: string[] }) {
  const [todos, setTodos] = useState(initial);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
        try {
          setTodos(await addTodo(input.value));
        } catch (err) {
          setError((err as Error).message); // "Sign in first"
        }
      }}
    >
      <input name="text" />
      <button type="submit">Add</button>
      {error && <p role="alert">{error}</p>}
      <ul>{todos.map((t) => <li>{t}</li>)}</ul>
    </form>
  );
}
```

- **Every export is a public endpoint.** Validate the input and authorize the caller in each
  one. `serverFn(schema, impl)` validates the first argument with any Standard Schema library
  (Zod, Valibot, ArkType) and answers 400 with `data.issues` before `impl` runs. `nowaki build`
  warns about exports that take arguments without it.
- Arguments and results travel as JSON.
- `getContext()` returns the calling request's context: cookies, headers, `session`.
- Throw `ServerFnError(message, { status, data })` for errors the client may see. On the
  client, the call rejects with an `Error` whose `message`, `status` and `data` come from it.
  Any other error is logged and reaches the client as a generic 500 "Internal Server Error" in
  production (dev keeps the message).
- Called from server code (a loader), a server function is a plain function call, with no HTTP.
- Server functions have no locale (`getLocale()` is undefined in them) and are not covered by
  the page CSRF check: the RPC endpoint has its own (JSON body, the `x-nowaki-rpc` header and an
  `Origin` check).

### As a form action

Inside an island, a server function can be a form's `action`. On submit, the form's fields go
to it as one plain object, and the result is dispatched on the form as a `nowaki:action` event
(`detail: { id, ok, result, error }`).

```tsx
// islands/QuickAdd.tsx
import { addTodoForm } from "../actions/todos.ts"; // "use server": (form: { text?: string }) => ...

export default function QuickAdd() {
  return (
    <form
      action={addTodoForm}
      ref={(f) => f?.addEventListener("nowaki:action", (e) => console.log((e as CustomEvent).detail.result))}
    >
      <input name="text" />
      <button type="submit">Add</button>
    </form>
  );
}
```

This type-checks with `"jsxImportSource": "@nowaki-dev/runtime"` in tsconfig.json (scaffolded
apps have it): Preact's JSX types with `<form action>` also taking a function. With
`"jsxImportSource": "preact"`, write `action={addTodoForm as unknown as string}`.

Working examples: `examples/hello/actions/todos.ts`, `examples/hello/islands/ServerTodos.tsx`,
`examples/hello/routes/server-fn.tsx`.

## Choosing one

- Data for the page: a `loader`.
- A form that should work without JavaScript: an `action` that redirects.
- An endpoint other clients call (a mobile app, a webhook, a feed): an API route or a file route.
- An island that needs server data or a write: a server function, or a
  [Jetstream live island](./jetstream.md) when the island is mostly server state.

## Reference

- [Runtime API](../reference/runtime.md) (`LoaderContext`, `Loader`, `Action`, `ApiHandler`,
  `serverFn`, `ServerFnError`, `getContext`)
- [Route module exports](../reference/route-exports.md) (`loader`, `action`, `streaming`,
  `csrf`, the method exports)
- [Environment variables](../reference/env-vars.md) (`NOWAKI_FORM_BODY_LIMIT`,
  `NOWAKI_FN_BODY_LIMIT`)
