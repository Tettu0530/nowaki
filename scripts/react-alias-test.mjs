// SSR React alias: with the runtime's resolve hook registered, `react*` imports from anywhere
// (including node_modules) load preact/compat. The repo root has no `react` installed, so
// without the hook these imports fail.
// ALIAS_SPECS must match resolve.rs `alias_specifier` and react-alias-hooks.mjs (checked below).
// Usage: node scripts/react-alias-test.mjs
import { readFileSync } from "node:fs";
import { register } from "node:module";

const hooksUrl = new URL("../packages/nowaki-runtime/server/react-alias-hooks.mjs", import.meta.url);
register(hooksUrl);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

// Every entry in react-alias-hooks.mjs ALIAS (except optional compiler-runtime; see below).
const ALIAS_SPECS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react-dom/server",
  "react-dom/test-utils",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "scheduler",
];

const hooksSrc = readFileSync(hooksUrl, "utf8");
const hookKeys = [...hooksSrc.matchAll(/^\s+(?:"([^"]+)"|(react|scheduler)):\s/gm)].map((m) => m[1] ?? m[2]);
check(
  "react-alias-hooks.mjs keys match ALIAS_SPECS + compiler-runtime",
  JSON.stringify([...hookKeys].sort()) === JSON.stringify([...ALIAS_SPECS, "react/compiler-runtime"].sort()),
);

const resolvePath = new URL("../crates/nowaki-core/src/resolve.rs", import.meta.url);
const resolveSrc = readFileSync(resolvePath, "utf8");
const aliasBlock = resolveSrc.slice(
  resolveSrc.indexOf("pub fn alias_specifier"),
  resolveSrc.indexOf("pub fn fs_path_to_url"),
);
const rustSpecs = [...aliasBlock.matchAll(/"([^"]+)"/g)]
  .map((m) => m[1])
  .filter((k) => k.startsWith("react") || k === "scheduler");
check(
  "resolve.rs alias_specifier keys match ALIAS_SPECS + compiler-runtime",
  JSON.stringify([...rustSpecs].sort()) === JSON.stringify([...ALIAS_SPECS, "react/compiler-runtime"].sort()),
);

const react = await import("react");
const compat = await import(new URL("../packages/nowaki-runtime/node_modules/preact/compat/dist/compat.mjs", import.meta.url).href).catch(() => null);
check("react resolves to preact/compat (has hooks)", typeof react.useState === "function");
check("react and react-dom are the same compat module", (await import("react-dom")).default === react.default);
if (compat) check("same preact/compat instance the runtime uses", compat.default === react.default);
check("react.Fragment is available", typeof react.Fragment !== "undefined");

const server = await import("react-dom/server");
check("react-dom/server exposes renderToString", typeof server.renderToString === "function");
const html = server.renderToString(react.createElement("p", null, "hi"));
check(`react-dom/server renders through preact (${html})`, html === "<p>hi</p>");

const client = await import("react-dom/client");
check("react-dom/client exposes hydrateRoot", typeof client.hydrateRoot === "function");

const jsx = await import("react/jsx-runtime");
check("react/jsx-runtime exposes jsx", typeof jsx.jsx === "function");
const jsxHtml = server.renderToString(jsx.jsx("em", { children: "via-jsx" }));
check("jsx-runtime renders through preact/SSR", jsxHtml === "<em>via-jsx</em>");

const jsxDev = await import("react/jsx-dev-runtime");
check("react/jsx-dev-runtime exposes jsxDEV", typeof jsxDev.jsxDEV === "function");

const testUtils = await import("react-dom/test-utils");
check("react-dom/test-utils exposes act", typeof testUtils.act === "function");

const scheduler = await import("scheduler");
check("scheduler resolves", typeof scheduler === "object");

for (const spec of ALIAS_SPECS) {
  try {
    await import(spec);
    check(`hook resolves ${spec}`, true);
  } catch (e) {
    check(`hook resolves ${spec}`, false);
    console.error(`  ${e.message}`);
  }
}

try {
  await import("react/compiler-runtime");
  check("react/compiler-runtime resolves when preact exports it", true);
} catch (e) {
  check(
    "react/compiler-runtime alias present but preact may omit export (skipped)",
    e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || /compiler-runtime/.test(String(e.message)),
  );
}

console.log(failures ? `\nREACT ALIAS TEST FAILED (${failures})` : "\nREACT ALIAS TEST PASSED");
process.exit(failures ? 1 : 0);
