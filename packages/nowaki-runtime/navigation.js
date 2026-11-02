// Type-safe navigation (@nowaki-dev/runtime/navigation). Kept separate from the barrel so
// importing it from a client island doesn't pull in node:async_hooks.

import { h } from "preact";

// route("/blog/[slug]", { slug: "x" }) → "/blog/x"。
// A catch-all ([...path]) joins its array with "/". Each segment is encodeURIComponent'd.
export function route(pattern, params = {}) {
  return pattern.replace(/\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g, (_, rest, one) => {
    if (rest) {
      const v = params[rest] ?? [];
      return (Array.isArray(v) ? v : [v]).map(encodeURIComponent).join("/");
    }
    return encodeURIComponent(params[one] ?? "");
  });
}

// Typed <a>. The client router intercepts clicks for SPA navigation (same as a plain <a>).
export function Link(props) {
  return h("a", props);
}
