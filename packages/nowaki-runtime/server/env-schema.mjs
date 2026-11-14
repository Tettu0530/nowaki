// env.ts: defineEnv declares the app's environment variables with Standard Schemas, and
// validateEnv checks a source (process.env, Worker bindings) against them. No Node imports: the
// edge adapters use this too.
import { setServerEnv } from "./env-store.mjs";

const MARK = "__nowakiEnv";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/// `{ server: { NAME: schema }, public: { PUBLIC_NAME: schema } }`. Public values are inlined into
/// client code as `import.meta.env.PUBLIC_NAME`, so only `PUBLIC_*` names may be public, and no
/// `PUBLIC_*` name may be server-only.
export function defineEnv(def = {}) {
  if (typeof def !== "object" || def === null) throw new TypeError("defineEnv: expected { server, public }");
  for (const k of Object.keys(def)) {
    if (k !== "server" && k !== "public") throw new TypeError(`defineEnv: unknown key "${k}" (expected server / public)`);
  }
  const check = (group, shape) => {
    if (shape === undefined) return Object.freeze({});
    if (typeof shape !== "object" || shape === null) throw new TypeError(`defineEnv: ${group} must be an object of schemas`);
    for (const [name, schema] of Object.entries(shape)) {
      if (!NAME.test(name)) throw new TypeError(`defineEnv: "${name}" is not a valid variable name`);
      const pub = name.startsWith("PUBLIC_");
      if (group === "public" && !pub) {
        throw new TypeError(`defineEnv: public variable "${name}" must start with PUBLIC_ (it is inlined into client code)`);
      }
      if (group === "server" && pub) {
        throw new TypeError(
          `defineEnv: server variable "${name}" must not start with PUBLIC_ (PUBLIC_* names reach the client); move it to public`,
        );
      }
      if (typeof schema?.["~standard"]?.validate !== "function") {
        throw new TypeError(`defineEnv: ${group}.${name} is not a Standard Schema (Zod, Valibot, ArkType, ...)`);
      }
    }
    return Object.freeze({ ...shape });
  };
  return Object.freeze({ server: check("server", def.server), public: check("public", def.public), [MARK]: true });
}

const pathOf = (issue) => {
  const keys = (issue.path ?? []).map((p) => (typeof p === "object" && p !== null ? p.key : p));
  return keys.length ? ` (at ${keys.join(".")})` : "";
};

/// The definition an imported env.ts module default-exports.
export function envDefinition(mod) {
  const def = mod?.default;
  if (!def || def[MARK] !== true) {
    throw new Error("env.ts must `export default defineEnv({ server, public })` (from @nowaki-dev/runtime/env)");
  }
  return def;
}

/// Validates `source` (name → string) against a definition. Returns `{ values: { server, public },
/// errors }`; an error names the variable and the schema's message, never the value.
export async function validateEnv(def, source) {
  const values = { server: {}, public: {} };
  const errors = [];
  for (const group of ["server", "public"]) {
    for (const [name, schema] of Object.entries(def[group] ?? {})) {
      const raw = source?.[name];
      let r;
      try {
        r = await schema["~standard"].validate(raw);
      } catch (err) {
        errors.push(`${name}: ${err?.message ?? err}`);
        continue;
      }
      if (r.issues) {
        const why = r.issues.map((i) => `${i.message}${pathOf(i)}`).join("; ");
        errors.push(raw === undefined ? `${name}: missing (${why})` : `${name}: ${why}`);
      } else {
        values[group][name] = r.value;
      }
    }
  }
  return { values, errors };
}

/// Startup: validates the env.ts module against `source` and makes the result what
/// `@nowaki-dev/runtime/env/server` returns. Throws, listing every problem, when invalid. With no
/// env.ts (`mod` null) env is empty. `builtPublic` (dist/server/env-public.json): the public
/// values the build inlined into client code; given, they are used as they are and only the
/// server variables are validated, so the server sees what the browser got.
export async function initServerEnv(mod, source, builtPublic) {
  if (!mod) {
    setServerEnv(null);
    return null;
  }
  const def = envDefinition(mod);
  const { values, errors } = await validateEnv(builtPublic ? { server: def.server } : def, source);
  if (errors.length) throw new Error(`[nowaki] env: invalid environment (env.ts):\n  ${errors.join("\n  ")}`);
  if (builtPublic) values.public = { ...builtPublic };
  setServerEnv(values);
  return values;
}
