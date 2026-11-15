# Deploy to Bun (bun adapter)

The bun adapter writes the same server entry as the [node adapter](./node.md), started with Bun
(through its `node:http` compatibility). Everything on the node page applies; only the start
command differs.

## Build

```sh
npx nowaki build --adapter bun
```

Output: `dist/server/index.mjs` with `dist/server/package.json` (`"start": "bun index.mjs"`),
next to `dist/client/` and `dist/public/`.

## Run

```sh
cd dist/server
npm install --omit=dev   # or: bun install --production
bun index.mjs
```

- It listens on `PORT` (default 3000) and `NOWAKI_HOST` (default `0.0.0.0`).
- Packages your server code imports must resolve from `dist/server`, as on Node: see
  [Your own dependencies](./node.md#your-own-dependencies).
- Bun is supported at its current stable release, which CI installs.

## What works

The same as the [node adapter](./node.md#what-works): everything but a server-side ISR cache
(ISR pages send `s-maxage` for a CDN; `revalidatePath` / `revalidateTag` are no-ops) and live
push (live island events are POSTs; `publish()`, presence and cross-visitor rooms do nothing).
Set the same [environment variables](./node.md#environment-variables).
