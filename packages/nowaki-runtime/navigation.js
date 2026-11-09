// Type-safe navigation (@nowaki-dev/runtime/navigation). Kept separate from the barrel so
// importing it from a client island doesn't pull in node:async_hooks.

import { h } from "preact";
import { withBase } from "./server/base-path.mjs";

// route("/blog/[slug]", { slug: "x" }) → "/blog/x"。
// A catch-all ([...path]) joins its array with "/". Each segment is encodeURIComponent'd.
export function route(pattern, params = {}) {
  return pattern.replace(/\[(\.\.\.)?([^[\]]+)\]/g, (_, dots, name) => {
    if (dots) {
      const v = params[name] ?? [];
      return (Array.isArray(v) ? v : [v]).map(encodeURIComponent).join("/");
    }
    return encodeURIComponent(params[name] ?? "");
  });
}

// Typed <a>. The client router intercepts clicks for SPA navigation (same as a plain <a>).
// Under nowaki.config `basePath`, a root-relative href gets the base in front (`basePath={false}`
// keeps it as written); a plain <a> is left alone.
export function Link(props) {
  if (!globalThis.__nowakiBase && props.basePath === undefined) return h("a", props);
  const { basePath, ...rest } = props;
  if (basePath !== false) rest.href = withBase(rest.href);
  return h("a", rest);
}
