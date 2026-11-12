// The CDN cache tag of a revalidate entry, shared by the Vercel and Cloudflare purges
// (purge-vercel.mjs, purge-cloudflare.mjs). Its own module so the Worker bundle never sees the
// lazy import of the Vercel package in purge-vercel.mjs (wrangler resolves it and fails).

// `%`, `,`, `"`, `\` and anything outside visible ASCII are percent-encoded (UTF-8): the tag is a
// plain ASCII header token whose length is its byte count. Same alphabet as revalidate.mjs
// `encodeEntries` plus the two characters Vercel counts escaped.
const encode = (s) => s.replace(/[^\x21\x23\x24\x26-\x2b\x2d-\x5b\x5d-\x7e]/gu, encodeURIComponent);

/// The CDN tag for a revalidate entry (`t:posts`, `p:/blog`): the entry itself, percent-encoded
/// where needed, or `h:<16 hex digits>` (a hash of the entry) when that is longer than `max`
/// characters (256 by default, Vercel's limit). The same function runs when a page is tagged and
/// when it is purged, so both sides agree. A hash collision only purges more than asked.
export function cdnTag(entry, max = 256) {
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
