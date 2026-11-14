// The validated environment behind `@nowaki-dev/runtime/env/server`. Startup (app.mjs, web.mjs,
// the dev sidecar) validates env.ts once and stores it (server/env-store.mjs); app code reads `env.X`. The values
// live on globalThis so every copy of this module (a bundled runtime, a workspace symlink) shares
// them. No Node imports: the edge adapters use this too.

const KEY = Symbol.for("nowaki.env");

function ready(key) {
  const v = globalThis[KEY];
  if (v) return v;
  throw new Error(
    `[nowaki] env.${String(key)} was read before the environment was validated. Declare it in env.ts (defineEnv) and read it in a loader, action, or handler rather than at module load.`,
  );
}

const readOnly = () => {
  throw new TypeError("[nowaki] env is read-only");
};

/** Server and public values from env.ts, validated at startup. Read-only. */
export const env = new Proxy(
  {},
  {
    get: (_, key) => (typeof key === "symbol" ? undefined : ready(key)[key]),
    has: (_, key) => typeof key === "string" && Object.hasOwn(ready(key), key),
    ownKeys: () => Reflect.ownKeys(ready("<keys>")),
    getOwnPropertyDescriptor: (_, key) => {
      const v = ready(key);
      return Object.hasOwn(v, key) ? { value: v[key], writable: false, enumerable: true, configurable: true } : undefined;
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
  },
);

