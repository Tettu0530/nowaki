// Typed environment: declare variables in the app root's env.ts with defineEnv and any Standard
// Schema library. Server code reads them from `@nowaki-dev/runtime/env/server`; public ones are
// inlined into client code as `import.meta.env.PUBLIC_*`. A missing or invalid variable fails the
// build and stops the server at startup.
export { defineEnv } from "./server/env-schema.mjs";
