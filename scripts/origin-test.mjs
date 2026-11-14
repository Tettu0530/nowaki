// Unit tests for server/origin.mjs (browserHost / isCrossSite / NOWAKI_TRUST_PROXY).
import { browserHost, isCrossSite, requestOrigin, requestUrl, trustProxy, trustSidecarHop } from "../packages/nowaki-runtime/server/origin.mjs";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const hdr = (map) => (name) => map[name.toLowerCase()];

delete process.env.NOWAKI_TRUST_PROXY;
delete process.env.VERCEL;
check("trustProxy defaults false", !trustProxy());

check(
  "browserHost ignores client x-forwarded-host on adapters",
  browserHost(hdr({ host: "app.example", "x-forwarded-host": "evil.test" })) === "app.example",
);

check(
  "forged x-forwarded-host cannot satisfy a cross-origin Origin",
  isCrossSite(
    hdr({
      origin: "https://evil.test",
      host: "app.example",
      "x-forwarded-host": "evil.test",
    }),
  ),
);

check(
  "same-origin Origin is not blocked by a forged x-forwarded-host",
  !isCrossSite(
    hdr({
      origin: "https://app.example",
      host: "app.example",
      "x-forwarded-host": "evil.test",
    }),
  ),
);

// Node / bun / deno adapters (no sidecar hop): a loopback Host is a reverse proxy on the same
// machine, which may pass a client's x-forwarded-* through, so they are not trusted.
check(
  "adapter: loopback Host does not trust a client x-forwarded-host",
  browserHost(hdr({ host: "localhost:3000", "x-forwarded-host": "evil.test" })) === "localhost:3000",
);
check(
  "adapter: loopback Host does not trust a client x-forwarded-proto / -host in requestOrigin",
  requestOrigin(hdr({ host: "127.0.0.1:3000", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" })) ===
    "http://127.0.0.1:3000",
);
check(
  "adapter: [::1] with a port is not a trusted hop either",
  browserHost(hdr({ host: "[::1]:3000", "x-forwarded-host": "evil.test" })) === "[::1]:3000",
);
check("adapter: no Host and a client x-forwarded-host gives no host", browserHost(hdr({ "x-forwarded-host": "evil.test" })) === undefined);

// requestUrl: the request target never picks the origin.
for (const t of ["//evil.test/reset", "http://evil.test/reset", "https://evil.test:8443/reset"]) {
  const u = requestUrl(t, "https://app.example");
  check(`requestUrl keeps the origin for ${t}`, u.origin === "https://app.example" && u.pathname === "/reset");
}
check("requestUrl keeps path and query", requestUrl("/a/b?x=1", "http://h:1").href === "http://h:1/a/b?x=1");
check("requestUrl: //evil.test/x?q=1 keeps the query", requestUrl("//evil.test/x?q=1", "http://h").href === "http://h/x?q=1");

// Inside a sidecar spawned by the Rust front, a loopback Host is the Rust hop.
trustSidecarHop();
check(
  "sidecar hop: [::1] with a port is loopback",
  browserHost(hdr({ host: "[::1]:3000", "x-forwarded-host": "app.example" })) === "app.example",
);
check(
  "browserHost uses x-forwarded-host when Host is absent (Rust sidecar hop)",
  browserHost(hdr({ "x-forwarded-host": "127.0.0.1:3301" })) === "127.0.0.1:3301",
);

check(
  "browserHost uses x-forwarded-host when connection Host is loopback",
  browserHost(
    hdr({
      host: "127.0.0.1:3301",
      "x-forwarded-host": "127.0.0.1:3300",
    }),
  ) === "127.0.0.1:3300",
);

check(
  "sidecar hop: same-origin with only x-forwarded-host is allowed",
  !isCrossSite(
    hdr({
      origin: "http://127.0.0.1:3300",
      "x-forwarded-host": "127.0.0.1:3300",
    }),
  ),
);

process.env.VERCEL = "1";
check(
  "browserHost uses Vercel edge x-forwarded-host for the public hostname",
  browserHost(
    hdr({ host: "my-app.vercel.app", "x-forwarded-host": "www.example.com" }),
  ) === "www.example.com",
);
delete process.env.VERCEL;

process.env.NOWAKI_TRUST_PROXY = "1";
check("trustProxy reads env", trustProxy());
check(
  "browserHost uses first x-forwarded-host when trust is on",
  browserHost(hdr({ host: "internal:8787", "x-forwarded-host": "app.example, other" })) === "app.example",
);
delete process.env.NOWAKI_TRUST_PROXY;

check(
  "requestOrigin: Rust sidecar hop uses the public host and proto, not the loopback Host",
  requestOrigin(
    hdr({ host: "127.0.0.1:51234", "x-forwarded-host": "app.example", "x-forwarded-proto": "https" }),
  ) === "https://app.example",
);
check(
  "requestOrigin: client x-forwarded-* are ignored on a public Host",
  requestOrigin(hdr({ host: "app.example", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" })) ===
    "http://app.example",
);
process.env.NOWAKI_TRUST_PROXY = "1";
check(
  "requestOrigin: trusted proxy sets host and proto",
  requestOrigin(hdr({ host: "10.0.0.5:3000", "x-forwarded-host": "app.example", "x-forwarded-proto": "https" })) ===
    "https://app.example",
);
delete process.env.NOWAKI_TRUST_PROXY;

check("Origin: null is treated as cross-site", isCrossSite(hdr({ origin: "null", host: "app.example" })));

check(
  "Sec-Fetch-Site: cross-site without Origin is cross-site",
  isCrossSite(hdr({ host: "app.example", "sec-fetch-site": "cross-site" })),
);
check(
  "Sec-Fetch-Site: same-origin without Origin is allowed",
  !isCrossSite(hdr({ host: "app.example", "sec-fetch-site": "same-origin" })),
);
check(
  "no Origin or Sec-Fetch-Site is not treated as cross-site (curl/server)",
  !isCrossSite(hdr({ host: "app.example" })),
);

console.log(failures ? `\nORIGIN TEST FAILED (${failures})` : "\nORIGIN TEST PASSED");
process.exit(failures ? 1 : 0);
