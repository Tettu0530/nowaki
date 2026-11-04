// Unit tests for server/origin.mjs (browserHost / isCrossSite / NOWAKI_TRUST_PROXY).
import { browserHost, isCrossSite, trustProxy } from "../packages/nowaki-runtime/server/origin.mjs";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const hdr = (map) => (name) => map[name.toLowerCase()];

delete process.env.NOWAKI_TRUST_PROXY;
check("trustProxy defaults false", !trustProxy());

check(
  "browserHost ignores client x-forwarded-host without trust",
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

check(
  "browserHost uses x-forwarded-host when Host is absent (Rust sidecar hop)",
  browserHost(hdr({ "x-forwarded-host": "127.0.0.1:3301" })) === "127.0.0.1:3301",
);

check(
  "sidecar hop: Origin matches x-forwarded-host, not connection Host",
  browserHost(
    hdr({
      origin: "http://127.0.0.1:3300",
      host: "127.0.0.1:3301",
      "x-forwarded-host": "127.0.0.1:3300",
    }),
  ) === "127.0.0.1:3300",
);

check(
  "adapter spoof: cross-site Origin cannot match via x-forwarded-host alone",
  browserHost(
    hdr({
      origin: "https://evil.test",
      host: "app.example",
      "x-forwarded-host": "evil.test",
    }),
  ) === "app.example",
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

process.env.NOWAKI_TRUST_PROXY = "1";
check("trustProxy reads env", trustProxy());
check(
  "browserHost uses first x-forwarded-host when trust is on",
  browserHost(hdr({ host: "internal:8787", "x-forwarded-host": "app.example, other" })) === "app.example",
);
delete process.env.NOWAKI_TRUST_PROXY;

console.log(failures ? `\nORIGIN TEST FAILED (${failures})` : "\nORIGIN TEST PASSED");
process.exit(failures ? 1 : 0);
