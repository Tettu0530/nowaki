// Content collections at runtime. `nowaki build` / `nowaki dev` read `content/` and render its
// Markdown (in Rust); validateContent runs each collection's schema from `content/config.ts` over
// the entries once, and getCollection / getEntry (`@nowaki-dev/runtime/content`) read the result.
// The store lives on globalThis so the app's import of the public module and the server's are the
// same one. No Node imports: the edge adapters use this too.

const KEY = Symbol.for("nowaki.content");

export function setContent(state) {
  globalThis[KEY] = state;
}

export function contentState() {
  return globalThis[KEY] ?? null;
}

const pathOf = (issue) => {
  const keys = (issue.path ?? []).map((p) => (typeof p === "object" && p !== null ? p.key : p));
  return keys.length ? `${keys.join(".")}: ` : "";
};

/// raw: `{ name: [{ slug, file, data, body?, html?, headings? }] }` (from Rust); config: the
/// module namespace of content/config. Returns `{ collections, errors }`; an entry whose data
/// fails its schema is left out and reported as `<file>: <field>: <message>`.
export async function validateContent(raw, config) {
  const defs = Object.fromEntries(
    Object.entries(config ?? {}).filter(([, v]) => v && v.__nowakiCollection === true),
  );
  const collections = {};
  const errors = [];
  for (const [name, entries] of Object.entries(raw ?? {})) {
    const def = defs[name];
    if (!def) {
      errors.push(
        `content/${name}: not declared in content/config.ts (export const ${name} = defineCollection({ schema }))`,
      );
      continue;
    }
    collections[name] = [];
    for (const e of entries) {
      let data = e.data;
      const std = def.schema?.["~standard"];
      if (std && typeof std.validate === "function") {
        let r = std.validate(e.data);
        if (r instanceof Promise) r = await r;
        if (r.issues) {
          for (const i of r.issues) errors.push(`${e.file}: ${pathOf(i)}${i.message}`);
          continue;
        }
        data = r.value;
      }
      collections[name].push(Object.freeze({ ...e, collection: name, data }));
    }
  }
  // Declared collections without a directory are empty, not unknown.
  for (const name of Object.keys(defs)) collections[name] ??= [];
  return { collections, errors };
}
