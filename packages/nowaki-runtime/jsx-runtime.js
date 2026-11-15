// `@nowaki-dev/runtime/jsx-runtime` (and `/jsx-dev-runtime`): Preact's JSX runtime, for tools
// that follow `"jsxImportSource": "@nowaki-dev/runtime"` in tsconfig.json. Nowaki's own transform
// imports `preact/jsx-runtime` directly; jsx-runtime.d.ts holds the JSX types.
export { Fragment, jsx, jsxDEV, jsxs } from "preact/jsx-runtime";
