// Client builds resolve `preact/jsx-runtime` (what the automatic JSX transform imports) here.
// Preact's own module is ~0.9 KB gzip of its own; everything it does for the browser is already
// in `createElement`, which ships with Preact anyway: `key` comes out of props, a function
// component keeps `ref` in its props, and children stay in `props.children`.
import { createElement, Fragment } from "preact";

export { Fragment };

export function jsx(type, props, key) {
  return createElement(type, key === undefined ? props : { ...props, key });
}

export { jsx as jsxs, jsx as jsxDEV };
