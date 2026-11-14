// Where startup puts the validated environment that `@nowaki-dev/runtime/env/server` reads
// (server/env-server.mjs). Internal: kept out of that public module so apps can't replace it.
// The values live on globalThis, so every copy of the runtime (a bundled one, a workspace symlink)
// shares them. No Node imports: the edge adapters use this too.

/// `{ server, public }` from validateEnv (null: no env.ts). Called once per process or isolate.
export function setServerEnv(validated) {
  globalThis[Symbol.for("nowaki.env")] = Object.freeze({ ...(validated?.public ?? {}), ...(validated?.server ?? {}) });
}
