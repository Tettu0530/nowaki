// SSR React alias: with the runtime's resolve hook registered, `react*` imports from anywhere
// (including node_modules) load preact/compat. The repo root has no `react` installed, so
// without the hook these imports fail.
// Usage: node scripts/react-alias-test.mjs
import { register } from "node:module";

register(new URL("../packages/nowaki-runtime/server/react-alias-hooks.mjs", import.meta.url));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const react = await import("react");
const compat = await import(new URL("../packages/nowaki-runtime/node_modules/preact/compat/dist/compat.mjs", import.meta.url).href).catch(() => null);
check("react resolves to preact/compat (has hooks)", typeof react.useState === "function");
check("react and react-dom are the same compat module", (await import("react-dom")).default === react.default);
if (compat) check("same preact/compat instance the runtime uses", compat.default === react.default);

const server = await import("react-dom/server");
check("react-dom/server exposes renderToString", typeof server.renderToString === "function");
const html = server.renderToString(react.createElement("p", null, "hi"));
check(`react-dom/server renders through preact (${html})`, html === "<p>hi</p>");

const client = await import("react-dom/client");
check("react-dom/client exposes hydrateRoot", typeof client.hydrateRoot === "function");
const jsx = await import("react/jsx-runtime");
check("react/jsx-runtime exposes jsx", typeof jsx.jsx === "function");
const scheduler = await import("scheduler");
check("scheduler resolves", typeof scheduler === "object");

console.log(failures ? `\nREACT ALIAS TEST FAILED (${failures})` : "\nREACT ALIAS TEST PASSED");
process.exit(failures ? 1 : 0);
