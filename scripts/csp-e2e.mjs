// CSP e2e against a server started with NOWAKI_CSP=enforce (or report-only with --report-only):
// the response's nonce goes on the scripts and styles Nowaki emits and on tags written with
// nonce(), never on a <script> / <style> that reached the page as raw HTML; ISR hits get a fresh
// nonce, streamed pages are covered too, and the render's marker never reaches the browser.
// Usage: node scripts/csp-e2e.mjs <baseUrl> [--report-only]   (nowaki start, dev, or an adapter)
// e2e-dev.sh, e2e-prod.sh and e2e-adapters.sh run it against examples/hello.
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
  const nonced = (t) => Boolean(nonce) && t.includes(`nonce="${nonce}"`);
  const tag = (id) => tags.find((t) => t.includes(`id="${id}"`)) ?? "";
  return { r, html, nonce, tags, nonced, tag, allNonced: tags.length > 0 && tags.every(nonced) };
}

// Pages whose only scripts and styles are Nowaki's (runtime, live.js, page scripts, the View
// Transition style) or use nonce().
for (const path of ["/", "/styled", "/stream", "/stream-early", "/vt", "/scripted", "/live"]) {
  const p = await page(path);
  check(`${path}: ${header} with a nonce`, Boolean(p.nonce));
  check(`${path}: all ${p.tags.length} script/style tags carry it`, p.allNonced);
  check(`${path}: no marker header reaches the browser`, !p.r.headers.has("x-nowaki-csp-marker"));
}

// Raw HTML in the page (dangerouslySetInnerHTML): no nonce for its tags, a guessed one stays wrong.
{
  const p = await page("/raw-html");
  check("raw HTML: Nowaki's runtime script has the nonce", p.nonced(p.tags.find((t) => t.includes('id="nowaki-runtime"') && t.includes(' src="')) ?? ""));
  check("raw HTML: the nonce() style has the nonce", p.nonced(p.tag("helper-style")));
  check("raw HTML: the injected <style> gets no nonce", p.tag("raw-style") !== "" && !/\snonce=/.test(p.tag("raw-style")));
  check("raw HTML: the injected <script> gets no nonce", p.tag("raw-script") !== "" && !/\snonce=/.test(p.tag("raw-script")));
  check("raw HTML: a guessed nonce is left as written", p.tag("raw-fake").includes('nonce="0123456789abcdef0123456789abcdef"') && !p.nonced(p.tag("raw-fake")));
  check("raw HTML: the fake runtime tag gets no nonce", !/\snonce=/.test(p.tags.find((t) => t.includes("evil.invalid")) ?? "x nonce="));
  const injected = (t) => /id="raw-|evil\.invalid/.test(t);
  check("raw HTML: every other tag (Nowaki's, nonce()) is nonced", p.tags.filter((t) => !injected(t)).every(p.nonced) && p.tags.filter(p.nonced).length >= 2);
}

// ISR hits: only where the server answers x-nowaki-cache, which is `nowaki start` (the adapters
// leave caching to the CDN; `nowaki dev` has no ISR cache), and not under --report-only.
const a = header === "content-security-policy" ? await page("/isr") : null;
if (a?.r.headers.has("x-nowaki-cache")) {
  const b = await page("/isr");
  check(`ISR repeat is served from cache (${b.r.headers.get("x-nowaki-cache")})`, /HIT|STALE/.test(b.r.headers.get("x-nowaki-cache") ?? ""));
  check("ISR responses get different nonces", Boolean(a.nonce && b.nonce) && a.nonce !== b.nonce);
  check("ISR cached response carries its own nonce on the nonce() style", b.allNonced);
  const others = [...b.html.matchAll(/nonce="([0-9a-f]{32})"/g)].filter((m) => m[1] !== b.nonce);
  check("ISR cached response shows no marker", !b.r.headers.has("x-nowaki-csp-marker") && others.length === 0);
}

// A public/ HTML file is served as written: its tags get no nonce, so it keeps its ETag (304).
{
  const p = await page("/plain.html");
  const etag = p.r.headers.get("etag");
  check("public/ HTML: its own tags get no nonce", p.tags.length > 0 && !p.tags.some((t) => /\snonce=/.test(t)));
  if (etag) {
    const again = await fetch(`${base}/plain.html`, { headers: { "if-none-match": etag } });
    check(`public/ HTML revalidates to 304 (${again.status})`, again.status === 304);
  }
}

// Only HTML gets the nonce policy (other responses keep the default `frame-ancestors` header).
const api = await fetch(`${base}/api/hello`);
check("non-HTML responses get no nonce policy", !/nonce-/.test(api.headers.get(header) ?? ""));

console.log(failures ? `\nCSP E2E FAILED (${failures})` : "\nCSP E2E PASSED");
process.exit(failures ? 1 : 0);
