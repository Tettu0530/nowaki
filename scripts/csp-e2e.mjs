// CSP e2e against a server started with NOWAKI_CSP=enforce (or report-only with --report-only):
// every <script>/<style> carries the response's nonce, ISR hits get a fresh nonce, and streamed
// pages are covered too.
// Usage: node scripts/csp-e2e.mjs <baseUrl> [--report-only]
const base = process.argv[2] ?? "http://127.0.0.1:3302";
const header = process.argv[3] === "--report-only" ? "content-security-policy-report-only" : "content-security-policy";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

async function page(path) {
  const r = await fetch(base + path);
  const html = await r.text();
  const nonce = /'nonce-([0-9a-f]{32})'/.exec(r.headers.get(header) ?? "")?.[1];
  const tags = html.match(/<(script|style)\b[^>]*>/gi) ?? [];
  const allNonced = tags.length > 0 && tags.every((t) => t.includes(`nonce="${nonce}"`));
  return { r, nonce, tags, allNonced };
}

for (const path of ["/", "/styled", "/stream"]) {
  const p = await page(path);
  check(`${path}: ${header} with a nonce`, Boolean(p.nonce));
  check(`${path}: all ${p.tags.length} script/style tags carry it`, p.allNonced);
}

if (header === "content-security-policy") {
  const a = await page("/isr");
  const b = await page("/isr");
  check(`ISR repeat is served from cache (${b.r.headers.get("x-nowaki-cache")})`, /HIT|STALE/.test(b.r.headers.get("x-nowaki-cache") ?? ""));
  check("ISR responses get different nonces", Boolean(a.nonce && b.nonce) && a.nonce !== b.nonce);
  check("ISR cached response carries its own nonce", b.allNonced);
}

// The default security headers still add `frame-ancestors` everywhere; only HTML gets the nonce policy.
const api = await fetch(`${base}/api/hello`);
check("non-HTML responses get no nonce policy", !/nonce-/.test(api.headers.get(header) ?? ""));

console.log(failures ? `\nCSP E2E FAILED (${failures})` : "\nCSP E2E PASSED");
process.exit(failures ? 1 : 0);
