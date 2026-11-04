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

process.env.NOWAKI_TRUST_PROXY = "1";
check("trustProxy reads env", trustProxy());
check(
  "browserHost uses first x-forwarded-host when trust is on",
  browserHost(hdr({ host: "internal:8787", "x-forwarded-host": "app.example, other" })) === "app.example",
);
delete process.env.NOWAKI_TRUST_PROXY;

console.log(failures ? `\nORIGIN TEST FAILED (${failures})` : "\nORIGIN TEST PASSED");
process.exit(failures ? 1 : 0);
