// Downloads remote images for `?image` at build time (`nowaki build`, `nowaki dev` on a cache miss);
// nothing fetches images at runtime. nowaki-core checks each URL against images.remotePatterns
// before it asks, and this script checks again, for the URL and for every redirect target.
//
// Usage: node images-fetch.mjs < { patterns, requests: [{ url, dir, stem }] }
//   → [{ ok: true } | { error }] on stdout, one per request. Each success writes
//   <dir>/<stem>.<png|jpg|webp|gif> and then <dir>/meta.json ({ url, file, finalUrl, type, size }).
//
// Limits: http(s) only; the host's every address must be public (no private, loopback,
// link-local, multicast, or reserved ranges, IPv4-mapped forms included), checked when the socket
// connects so a DNS answer can't change between the check and the request; at most 3 redirects,
// each allowed by the patterns; 20 MB, streamed and aborted past the limit; 15 s per image; the
// body must be a PNG, JPEG, WebP, or GIF by its bytes.
//
// NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS=1 lets loopback addresses through (and nothing else), so
// tests can serve images from 127.0.0.1. Never set it for a real build.
import dns from "node:dns";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_BYTES = 20 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;
const CONCURRENCY = 6;

// The same strict parse as `remote_image.rs` `parse_remote_url` (shared fixture:
// crates/nowaki-core/tests/fixtures/remote-patterns-cases.json).
export function parseRemoteUrl(url) {
  if (typeof url !== "string") return null;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c >= 0x80 || c === 0x5c || c === 0x23) return null;
  }
  const sep = url.indexOf("://");
  if (sep < 0) return null;
  const protocol = url.slice(0, sep);
  if (protocol !== "https" && protocol !== "http") return null;
  const rest = url.slice(sep + 3);
  let authEnd = rest.search(/[/?]/);
  if (authEnd < 0) authEnd = rest.length;
  const authority = rest.slice(0, authEnd);
  const tail = rest.slice(authEnd);
  if (authority === "" || authority.includes("@")) return null;
  let host = authority;
  let port = null;
  const colon = authority.indexOf(":");
  if (colon >= 0) {
    host = authority.slice(0, colon);
    const p = authority.slice(colon + 1);
    if (!/^\d{1,5}$/.test(p)) return null;
    port = Number(p);
    if (port === 0 || port > 65535) return null;
  }
  const hostname = host.toLowerCase();
  if (!validHostname(hostname)) return null;
  if (port === (protocol === "https" ? 443 : 80)) port = null;
  const q = tail.indexOf("?");
  let pathname = q >= 0 ? tail.slice(0, q) : tail;
  if (pathname === "") pathname = "/";
  if (pathname[0] !== "/" || !safePath(pathname)) return null;
  return { protocol, hostname, port, pathname };
}

function validHostname(h) {
  return h.length > 0 && h.length <= 253 && h.split(".").every((l) => l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/.test(l));
}

function safePath(p) {
  const lower = p.toLowerCase();
  if (lower.includes("%2f") || lower.includes("%5c")) return false;
  return p.split("/").every((seg) => {
    const s = seg.toLowerCase().replaceAll("%2e", ".");
    return s !== "." && s !== "..";
  });
}

export function isAllowed(url, patterns) {
  const u = parseRemoteUrl(url);
  return !!u && (patterns ?? []).some((p) => patternMatches(p, u));
}

function patternMatches(p, u) {
  const protocol = p.protocol ? String(p.protocol).replace(/:$/, "") : "https";
  if (protocol !== u.protocol) return false;
  let want = null;
  if (p.port !== undefined && p.port !== null && p.port !== "") {
    if (!/^\d{1,5}$/.test(String(p.port)) || Number(p.port) > 65535) return false;
    want = Number(p.port);
  }
  if (want === (u.protocol === "https" ? 443 : 80)) want = null;
  if (want !== u.port) return false;
  if (!hostMatches(String(p.hostname).toLowerCase(), u.hostname)) return false;
  return globMatch(p.pathname ?? "/**", u.pathname);
}

function hostMatches(pattern, host) {
  for (const [prefix, oneLabel] of [["**.", false], ["*.", true]]) {
    if (!pattern.startsWith(prefix)) continue;
    const suffix = "." + pattern.slice(prefix.length);
    if (!host.endsWith(suffix)) return false;
    const pre = host.slice(0, -suffix.length);
    return pre.length > 0 && (!oneLabel || !pre.includes("."));
  }
  return pattern === host;
}

// `**` matches anything (including `/`), `*` anything but `/`.
function globMatch(pat, s) {
  if (pat.startsWith("**")) {
    const rest = pat.slice(2);
    for (let i = 0; i <= s.length; i++) if (globMatch(rest, s.slice(i))) return true;
    return false;
  }
  if (pat === "") return s === "";
  if (pat[0] === "*") {
    const rest = pat.slice(1);
    for (let i = 0; i <= s.length; i++) {
      if (globMatch(rest, s.slice(i))) return true;
      if (s[i] === "/") break;
    }
    return false;
  }
  return s[0] === pat[0] && globMatch(pat.slice(1), s.slice(1));
}

function ipv4Bytes(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) ? b : null;
}

function ipv6Bytes(a) {
  a = a.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  let tailV4 = null;
  const lastColon = a.lastIndexOf(":");
  if (a.slice(lastColon + 1).includes(".")) {
    tailV4 = ipv4Bytes(a.slice(lastColon + 1));
    if (!tailV4) return null;
    a = a.slice(0, lastColon + 1) + "0:0";
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const part = (s) => (s === "" ? [] : s.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  if (tailV4) out.splice(12, 4, ...tailV4);
  return out;
}

function blockedV4([a, b, c], allowLoopback) {
  if (a === 127) return !allowLoopback;
  return (
    a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

/// Whether a resolved address is one a build must never fetch from. Unparsable → blocked.
export function isBlockedAddress(address, allowLoopback = false) {
  const v4 = ipv4Bytes(address);
  if (v4) return blockedV4(v4, allowLoopback);
  const b = ipv6Bytes(address);
  if (!b) return true;
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 15) && b[15] === 1) return !allowLoopback; // ::1
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return blockedV4(b.slice(12), allowLoopback); // ::ffff:a.b.c.d
  if (zero(0, 12)) return true; // ::, and the deprecated ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return blockedV4(b.slice(12), allowLoopback); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6), allowLoopback); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true; // discard
  if ((b[0] & 0xfe) === 0xfc) return true; // unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // site-local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

class Refused extends Error {}

// Checks every address of a host when the socket connects, so the check and the connection use
// the same DNS answer.
function safeLookup(allowLoopback) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find((a) => isBlockedAddress(a.address, allowLoopback));
      if (bad) return cb(new Refused(`${hostname} resolves to a private or loopback address (${bad.address})`));
      if (options?.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function get(url, signal, allowLoopback) {
  const u = new URL(url);
  // An IP literal never goes through the lookup.
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && isBlockedAddress(literal, allowLoopback)) {
    return Promise.reject(new Refused(`${literal} is a private or loopback address`));
  }
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, {
      agent: false,
      lookup: safeLookup(allowLoopback),
      signal,
      headers: { "user-agent": "nowaki-images", accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
    });
    req.on("response", resolve);
    req.on("error", reject);
  });
}

async function readCapped(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      throw new Refused(`larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/// The format of `b` from its first bytes, as the file extension; null for anything else.
export function sniff(b) {
  if (b.length >= 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/// Downloads one image into `req.dir` (see the header comment). Throws why it couldn't.
export async function fetchImage(req, patterns, opts = {}) {
  const { allowLoopback = false, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = opts;
  if (!isAllowed(req.url, patterns)) throw new Refused("not allowed by images.remotePatterns");
  const stem = /^[A-Za-z0-9_-]{1,64}$/.test(req.stem ?? "") ? req.stem : "image";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let url = req.url;
    for (let hop = 0; ; hop++) {
      const res = await get(url, ac.signal, allowLoopback);
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        const location = res.headers.location;
        if (!location) throw new Error(`HTTP ${status} without a location`);
        if (hop >= maxRedirects) throw new Refused(`more than ${maxRedirects} redirects`);
        const next = new URL(location, url);
        next.hash = "";
        if (!isAllowed(next.href, patterns)) throw new Refused(`redirect to ${next.href} is not allowed by images.remotePatterns`);
        url = next.href;
        continue;
      }
      if (status !== 200) {
        res.resume();
        throw new Error(`HTTP ${status}`);
      }
      const declared = Number(res.headers["content-length"]);
      if (declared > maxBytes) {
        res.destroy();
        throw new Refused(`larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      const body = await readCapped(res, maxBytes);
      const type = sniff(body);
      if (!type) throw new Refused("not a PNG, JPEG, WebP or GIF image");
      const file = `${stem}.${type}`;
      await mkdir(req.dir, { recursive: true });
      await writeFile(path.join(req.dir, file + ".tmp"), body);
      await rename(path.join(req.dir, file + ".tmp"), path.join(req.dir, file));
      // meta.json last: its presence marks a complete download.
      const meta = { url: req.url, file, finalUrl: url, type: MIME[type], size: body.length };
      await writeFile(path.join(req.dir, "meta.json"), JSON.stringify(meta));
      return meta;
    }
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`timed out after ${timeoutMs / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { patterns = [], requests = [] } = JSON.parse(readFileSync(0, "utf8"));
  const allowLoopback = process.env.NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS === "1";
  if (allowLoopback) console.error("[nowaki] NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS is set: loopback addresses are allowed");
  const results = new Array(requests.length);
  let next = 0;
  async function worker() {
    while (next < requests.length) {
      const i = next++;
      try {
        await fetchImage(requests[i], patterns, { allowLoopback });
        results[i] = { ok: true };
      } catch (e) {
        await rm(requests[i].dir, { recursive: true, force: true }).catch(() => {});
        results[i] = { error: e?.message ?? String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, worker));
  process.stdout.write(JSON.stringify(results));
}

// Run as a script (the CLI starts it through node_modules, a symlink under pnpm); imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
