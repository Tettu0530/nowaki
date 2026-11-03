// Node resolve hook: React imports from node_modules go to preact/compat during SSR. The Rust
// transform only aliases app sources, so without this a library's `import "react"` loads real
// React next to Preact and every hook call fails. Keep in sync with resolve.rs `alias_specifier`.

const ALIAS = {
  react: "preact/compat",
  "react-dom": "preact/compat",
  "react-dom/client": "preact/compat/client",
  "react-dom/server": "preact/compat/server",
  "react-dom/test-utils": "preact/test-utils",
  "react/jsx-runtime": "preact/jsx-runtime",
  "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
  "react/compiler-runtime": "preact/compat/compiler-runtime",
  scheduler: "preact/compat/scheduler",
};

export async function resolve(specifier, context, nextResolve) {
  const target = ALIAS[specifier];
  if (target) {
    // Resolve from the runtime package so SSR and the renderer share one preact instance.
    return nextResolve(target, { ...context, parentURL: import.meta.url });
  }
  return nextResolve(specifier, context);
}
