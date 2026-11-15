# Deploy to Deno (deno adapter)

The deno adapter writes the same server entry as the [node adapter](./node.md), started with
Deno's Node compatibility. Everything on the node page applies; only the start command differs.

## Build

```sh
npx nowaki build --adapter deno
```

Output: `dist/server/index.mjs` with `dist/server/package.json`
(`"start": "deno run -A index.mjs"`), next to `dist/client/` and `dist/public/`.

## Run

```sh
cd dist/server
npm install --omit=dev
deno run -A index.mjs
```

- `-A` grants every permission: the server reads its files, the environment and `.env`, and
  listens on the network. Narrow it with `--allow-*` flags if your deployment needs to.
- It listens on `PORT` (default 3000) and `NOWAKI_HOST` (default `0.0.0.0`).
- Packages your server code imports must resolve from `dist/server`, as on Node: see
  [Your own dependencies](./node.md#your-own-dependencies).
- Deno is supported at its current stable release, which CI installs.

## What works

The same as the [node adapter](./node.md#what-works): everything but a server-side ISR cache
(ISR pages send `s-maxage` for a CDN; `revalidatePath` / `revalidateTag` are no-ops) and live
push (live island events are POSTs; `publish()`, presence and cross-visitor rooms do nothing).
Set the same [environment variables](./node.md#environment-variables).
