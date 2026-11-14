// Types for `@nowaki-dev/runtime/env`: `defineEnv` in the app root's env.ts.

import type { StandardSchemaV1 } from "./index.js";

type Shape = Record<string, StandardSchemaV1>;

/** What {@link defineEnv} returns: the schemas of the server and the public variables. */
export interface EnvDefinition<S extends Shape = Shape, P extends Shape = Shape> {
  /** Server-only variables by name. */
  readonly server: Readonly<S>;
  /** Public variables (`PUBLIC_*`) by name. */
  readonly public: Readonly<P>;
}

/** A schema's output type (what validation returns). */
export type EnvOutput<S> = S extends { readonly "~standard": { readonly types?: infer T } }
  ? T extends { readonly output: infer O }
    ? O
    : unknown
  : unknown;

/** The validated values of a shape of schemas. */
export type EnvValues<S> = { readonly [K in keyof S]: EnvOutput<S[K]> };

/** Server-side values of a definition: the server and the public variables. Used by typegen. */
export type ServerEnvOf<D> = D extends EnvDefinition<infer S, infer P> ? EnvValues<S> & EnvValues<P> : {};

/** Public values of a definition (`import.meta.env.PUBLIC_*`). Used by typegen. */
export type PublicEnvOf<D> = D extends EnvDefinition<Shape, infer P> ? EnvValues<P> : {};

/**
 * Declares the app's environment variables in the app root's `env.ts`, each with a Standard
 * Schema (Zod, Valibot, ArkType, ...). `nowaki build` validates them (a missing or invalid one
 * fails the build), and so does every server at startup.
 *
 * - `server`: read with `import { env } from "@nowaki-dev/runtime/env/server"`. Never reaches
 *   client code; names must not start with `PUBLIC_`.
 * - `public`: names start with `PUBLIC_`; the validated values (strings, numbers, booleans, or
 *   null) are inlined into client and server code as `import.meta.env.PUBLIC_*`. The scaffolded
 *   `nowaki-env.d.ts` types any `PUBLIC_*` as `string | undefined`, so a non-string output
 *   (`z.coerce.number()`) is a type error there; widen that index signature to use one.
 */
export declare function defineEnv<S extends Shape = {}, P extends Shape = {}>(def: {
  server?: S;
  public?: P;
}): EnvDefinition<S, P>;
