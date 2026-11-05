// Unit tests for the client router's pure logic (router-core.js).
// No DOM dependency, so it runs as-is in Node (matchBoundary / createPageCache).
import assert from "node:assert/strict";
import { matchBoundary, createPageCache } from "../packages/nowaki-runtime/client/router-core.js";

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
