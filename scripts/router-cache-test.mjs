// Unit tests for the client router's pure logic (router-core.js).
// No DOM dependency, so it runs as-is in Node (matchBoundary / matchPattern / createPageCache).
import assert from "node:assert/strict";
import { matchBoundary, matchPattern, createPageCache } from "../packages/nowaki-runtime/client/router-core.js";

let passed = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  console.log(`ok   ${label}`);
  passed++;
};

// matchBoundary: longest prefix match
const boundaries = [
  { prefix: "", html: "root" },
  { prefix: "/blog", html: "blog" },
  { prefix: "/blog/admin", html: "admin" },
];
ok("root boundary matches an unrelated path", matchBoundary(boundaries, "/about").html === "root");
ok("/blog boundary matches /blog itself", matchBoundary(boundaries, "/blog").html === "blog");
ok("/blog boundary matches a child", matchBoundary(boundaries, "/blog/hello").html === "blog");
ok("deeper boundary wins (most specific)", matchBoundary(boundaries, "/blog/admin/x").html === "admin");
ok("/blogger does NOT match /blog prefix", matchBoundary(boundaries, "/blogger").html === "root");
// A boundary in a [param] directory: the prefix is the directory as written.
const dyn = [
  { prefix: "", html: "root" },
  { prefix: "/org/[org]", html: "org" },
  { prefix: "/abcdefgh", html: "long" },
  { prefix: "/abcdefgh/[x]/y", html: "deep" },
];
ok("[param] boundary matches a real segment", matchBoundary(dyn, "/org/acme/settings").html === "org");
ok("[param] boundary needs its segment", matchBoundary(dyn, "/org").html === "root");
ok("deeper wins by segments, not string length", matchBoundary(dyn, "/abcdefgh/z/y").html === "deep");
ok("literal prefix compared percent-decoded", matchBoundary([{ prefix: "/admin", html: "a" }], "/%61dmin/x")?.html === "a");
ok("malformed escape doesn't throw", matchBoundary([{ prefix: "/admin", html: "a" }], "/50%/x") === null);
ok("suffixed [id].v2 boundary needs the suffix", matchBoundary([{ prefix: "/r/[id].v2", html: "v2" }], "/r/7/x") === null);
ok("suffixed [id].v2 boundary matches with it", matchBoundary([{ prefix: "/r/[id].v2", html: "v2" }], "/r/7.v2/x")?.html === "v2");
ok("no boundaries → null", matchBoundary([], "/x") === null);
ok("no root boundary and no match → null", matchBoundary([{ prefix: "/p" }], "/q") === null);
ok(
  "prefix stored with trailing slash still matches children",
  matchBoundary([{ prefix: "/blog/", html: "blog" }], "/blog/post").html === "blog",
);
ok(
  "exact pathname matches boundary without requiring a child segment",
  matchBoundary([{ prefix: "/exact", html: "exact" }], "/exact").html === "exact",
);

// A route group's boundary (routes/(app)/loading.tsx: prefix "") lists its routes, and only those
// get it: /about, served by routes/about.tsx outside the group, gets the root one.
const grouped = [
  { prefix: "", html: "root" },
  { prefix: "", html: "app", routes: ["/dashboard", "/projects/[id]"] },
];
ok("a group boundary applies to its own routes", matchBoundary(grouped, "/projects/7").html === "app");
ok("a group boundary skips URLs outside the group", matchBoundary(grouped, "/about").html === "root");
ok("no boundary outside the group without a root one", matchBoundary(grouped.slice(1), "/about") === null);
const docs = [{ prefix: "/docs", html: "docs", routes: ["!/docs/guide", "/docs/[slug]"] }];
ok("a URL a more specific route outside the group serves isn't the group's", matchBoundary(docs, "/docs/guide") === null);
ok("the group's [slug] route still gets it", matchBoundary(docs, "/docs/intro")?.html === "docs");

// matchPattern: a whole URL path against a route pattern (intercepting routes).
ok("matchPattern: param", matchPattern("/photo/[id]", "/photo/1"));
ok("matchPattern: not a prefix match", !matchPattern("/photo/[id]", "/photo/1/x") && !matchPattern("/photo/[id]", "/photo"));
ok("matchPattern: trailing slash ignored", matchPattern("/app/photo/[id]", "/app/photo/1/"));
ok("matchPattern: catch-all needs one segment", matchPattern("/docs/[...r]", "/docs/a/b") && !matchPattern("/docs/[...r]", "/docs"));
ok("matchPattern: suffix", matchPattern("/og/[c].png", "/og/x.png") && !matchPattern("/og/[c].png", "/og/x"));
ok("matchPattern: literals compared decoded", matchPattern("/caf\u00e9/[id]", "/caf%C3%A9/1"));
ok("matchPattern: root", matchPattern("/", "/") && !matchPattern("/", "/a"));
ok("matchPattern: malformed escape is no match", !matchPattern("/[id]", "/50%"));

// createPageCache: advance time with a controllable now
let t = 0;
const now = () => t;
const cache = createPageCache({ ttlMs: 1000, max: 2, now });

cache.set("/a", "A");
ok("get returns the stored value", cache.get("/a") === "A");
ok("has is true while fresh", cache.has("/a") === true);

t = 999;
ok("still fresh just before TTL", cache.get("/a") === "A");
t = 1001;
ok("stale after TTL → get undefined", cache.get("/a") === undefined);
ok("stale entry is evicted (size 0)", cache.size() === 0);
ok("has is false after TTL", cache.has("/a") === false);

t = 0;
const upd = createPageCache({ ttlMs: 1000, max: 2, now });
upd.set("/k", "v1");
upd.set("/k", "v2");
ok("set replaces value for the same key", upd.get("/k") === "v2");

// LRU: capacity 2. The 3rd entry evicts the oldest, but one touched by get stays.
t = 0;
const lru = createPageCache({ ttlMs: 100000, max: 2, now });
lru.set("/1", 1);
lru.set("/2", 2);
lru.get("/1"); // mark /1 as recently used
lru.set("/3", 3); // oldest = /2 is evicted
ok("LRU keeps the recently-used entry", lru.get("/1") === 1);
ok("LRU evicts the least-recently-used entry", lru.get("/2") === undefined);
ok("LRU keeps the newest entry", lru.get("/3") === 3);
ok("LRU respects max size", lru.size() === 2);

cache.clear();
ok("clear drops all entries", cache.size() === 0 && cache.get("/a") === undefined);
cache.set("/x", 1);
cache.delete("/x");
ok("delete removes an entry", cache.get("/x") === undefined && cache.has("/x") === false);

const instant = createPageCache({ ttlMs: 0, max: 8, now: () => 0 });
instant.set("/z", 1);
ok("ttlMs 0 treats entries as immediately stale", instant.get("/z") === undefined && !instant.has("/z"));

const cap1 = createPageCache({ ttlMs: 100_000, max: 1, now: () => 0 });
cap1.set("/first", 1);
cap1.set("/second", 2);
ok("max 1 evicts the previous entry", cap1.get("/first") === undefined && cap1.get("/second") === 2 && cap1.size() === 1);

console.log(`\nROUTER CACHE TEST PASSED (${passed} assertions)`);
