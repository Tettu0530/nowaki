// CDN purge for the Vercel adapter: the `env.purge` / `env.cacheTagHeader` seams of handler.mjs
// (server/revalidate.mjs collects the entries). Runtime-neutral: nothing is imported up front, and
// `@vercel/functions` is loaded on the first purge only, so an app that never calls revalidate*()
// pays nothing for it.
//
// - ISR responses carry `Vercel-Cache-Tag`, a comma-separated list Vercel's CDN reads (and strips
//   before the browser sees it). The tags are the route's `t:<tag>` entries plus `p:<browser path>`,
//   so revalidatePath() is a purge by tag too.
// - A purge calls `dangerouslyDeleteByTag` from `@vercel/functions` (decision: purged pages are
//   deleted, so the next request renders fresh). vercel-build.mjs copies the package into the
//   function when the app has it installed; without it, a purge warns once and does nothing.
//
// Vercel's limits (vercel.com/docs/caching/cdn-cache/purge#limits): at most 256 UTF-8 bytes per
// tag, quotes and backslashes counting escaped, no commas, 128 tags per response, tags are case
// sensitive. `cdnTag` keeps every tag within them (Nowaki sends at most 64 route tags + 1 path).

export const VERCEL_TAG_HEADER = "vercel-cache-tag";
const TAG_MAX = 256;
const TIMEOUT_MS = 2000;
// The bulk REST call takes 16 tags; the function API is kept to the same batch size.
const BATCH = 16;

// `%`, `,`, `"`, `\` and anything outside visible ASCII are percent-encoded (UTF-8): the tag is a
// plain ASCII header token whose length is its byte count. Same alphabet as revalidate.mjs
// `encodeEntries` plus the two characters Vercel counts escaped.
const encode = (s) => s.replace(/[^\x21\x23\x24\x26-\x2b\x2d-\x5b\x5d-\x7e]/gu, encodeURIComponent);

/// The CDN tag for a revalidate entry (`t:posts`, `p:/blog`): the entry itself, percent-encoded
/// where needed, or `h:<16 hex digits>` (a hash of the entry) when that is longer than `max`
/// characters. The same function runs when a page is tagged and when it is purged, so both sides
/// agree. A hash collision only purges more than asked.
export function cdnTag(entry, max = TAG_MAX) {
  const t = encode(entry);
  return t.length <= max ? t : `h:${hash64(entry)}`;
}

// 64-bit FNV-1a over the UTF-8 bytes (two 32-bit halves with different offsets), as hex.
function hash64(s) {
  const bytes = new TextEncoder().encode(s);
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (const x of bytes) {
    a = Math.imul(a ^ x, 0x01000193);
    b = Math.imul(b ^ x, 0x01000193) ^ (a >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

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
