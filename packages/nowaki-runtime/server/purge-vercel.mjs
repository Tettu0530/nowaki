// CDN purge for the Vercel adapter: the `env.purge` / `env.cacheTagHeader` seams of handler.mjs
// (server/revalidate.mjs collects the entries). Runtime-neutral: nothing is imported up front, and
// `@vercel/functions` is loaded on the first purge only, so an app that never calls revalidate*()
// pays nothing for it.
//
// - ISR responses carry `Vercel-Cache-Tag`, a comma-separated list Vercel's CDN reads (and strips
//   before the browser sees it). The tags are the route's `t:<tag>` entries plus `p:<browser path>`,
//   so revalidatePath() is a purge by tag too.
// - A purge calls `dangerouslyDeleteByTag` from `@vercel/functions` (purged pages are
//   deleted rather than marked stale, so the next request renders fresh). vercel-build.mjs
//   copies the package into the function when the app has it installed; without it, a purge warns once and does nothing.
//
// Vercel's limits (vercel.com/docs/caching/cdn-cache/purge#limits): at most 256 UTF-8 bytes per
// tag, quotes and backslashes counting escaped, no commas, 128 tags per response, tags are case
// sensitive. `cdnTag` keeps every tag within them (Nowaki sends at most 64 route tags + 1 path).

import { cdnTag } from "./cdn-tag.mjs";

// The tag encoding lives in cdn-tag.mjs (shared with the Cloudflare purge); re-exported here.
export { cdnTag };

export const VERCEL_TAG_HEADER = "vercel-cache-tag";
const TIMEOUT_MS = 2000;
// The bulk REST call takes 16 tags; the function API is kept to the same batch size.
const BATCH = 16;

/// `{ purge, cacheTagHeader }` for createApp's `cdn` option. `load` (tests) replaces the import of
/// `@vercel/functions`; `timeoutMs` bounds how long a purge holds the response (2 s).
export function vercelCdn({ load = () => import("@vercel/functions"), timeoutMs = TIMEOUT_MS } = {}) {
  let api;
  const warned = new Set();
  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(msg);
  };
  const loadApi = () =>
    (api ??= Promise.resolve()
      .then(load)
      .then((mod) => {
        const del = mod?.dangerouslyDeleteByTag ?? mod?.default?.dangerouslyDeleteByTag;
        if (typeof del !== "function") throw new Error("@vercel/functions has no dangerouslyDeleteByTag (needs 3.1 or newer)");
        return del;
      })
      .catch((err) => {
        if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
          warnOnce(
            "missing",
            "[nowaki] revalidatePath / revalidateTag can't purge Vercel's CDN: add @vercel/functions to the app's dependencies and rebuild. Until then, cached pages still carry Vercel-Cache-Tag, so they can be purged from the dashboard or the REST API.",
          );
        } else {
          warnOnce("load", `[nowaki] Vercel cache purge is unavailable: ${err?.message ?? err}`);
        }
        return null;
      }));

  return {
    cacheTagHeader(entries) {
      let value = "";
      for (const e of entries) value = value ? `${value},${cdnTag(e)}` : cdnTag(e);
      return value ? { [VERCEL_TAG_HEADER]: value } : null;
    },
    async purge(entries) {
      const del = await loadApi();
      if (!del) return;
      if (!globalThis.process?.env?.VERCEL) {
        warnOnce("local", "[nowaki] not running on Vercel (VERCEL is unset): revalidate calls don't reach a CDN here.");
      }
      const tags = [...new Set(entries.map((e) => cdnTag(e)))];
      const calls = [];
      for (let i = 0; i < tags.length; i += BATCH) calls.push(del(tags.slice(i, i + BATCH)));
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs, "timeout");
      });
      try {
        const r = await Promise.race([Promise.all(calls), timeout]);
        if (r === "timeout") console.warn(`[nowaki] Vercel cache purge did not finish within ${timeoutMs} ms; the response goes out without waiting for it.`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
