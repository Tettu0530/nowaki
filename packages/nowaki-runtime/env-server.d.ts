/**
 * The validated environment from env.ts (`@nowaki-dev/runtime/env/server`). `nowaki typegen` fills
 * this in, so `env.X` is typed by the schema's output. Without it, any name is `unknown`.
 */
export interface ServerEnv {}

type EnvShape = keyof ServerEnv extends never ? { readonly [name: string]: unknown } : Readonly<ServerEnv>;

/**
 * Server and public variables from env.ts, validated once at startup. Read-only. Server-only:
 * importing this module from client code (an island or a page script) fails the build. Read it in
 * a loader, action or handler: a read at module load, before validation, throws.
 */
export declare const env: EnvShape;
