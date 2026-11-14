// Unit test for server/csp.mjs (the adapters' CSP) and server/nonce.mjs (the render's marker):
// only the tags carrying the render's marker get the nonce, in strings and across stream chunks;
// the policy; applyCsp's pass-through rules; and nonce() / nonceAttr() inside and outside a render.
// Usage: node scripts/csp-test.mjs
process.env.NOWAKI_CSP = "enforce";
const { stampMarker, markerTransform, cspPolicy, applyCsp, newNonce, CSP_MARKER_HEADER } = await import(
  "../packages/nowaki-runtime/server/csp.mjs"
);
const { cspOn, markResult, nonce, nonceAttr, withCspMarker } = await import("../packages/nowaki-runtime/server/nonce.mjs");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const M = "0123456789abcdef0123456789abcdef";
const marked = `<style nonce="${M}">a{}</style><style>raw{}</style><script nonce="${M}" type="module" src="/x.js"></script><SCRIPT>1</SCRIPT><script nonce="guess">2</script>`;
check("only tags with the marker get the nonce",
  stampMarker(marked, M, 'nonce="n"') ===
    '<style nonce="n">a{}</style><style>raw{}</style><script nonce="n" type="module" src="/x.js"></script><SCRIPT>1</SCRIPT><script nonce="guess">2</script>');
check("HTML without the marker is untouched",
  stampMarker('<script>1</script><style nonce="">a{}</style><p>nonce="x"</p>', M, 'nonce="n"') === '<script>1</script><style nonce="">a{}</style><p>nonce="x"</p>');

async function streamed(chunks, to = 'nonce="n"') {
  const rs = new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  }).pipeThrough(markerTransform(M, to));
  let out = "";
  for await (const x of rs) out += x;
  return out;
}
const two = `<p>a</p><script nonce="${M}">1</script><style nonce="${M}">b</style>`;
let splits = true;
for (let at = 1; at < two.length; at++) {
  if ((await streamed([two.slice(0, at), two.slice(at)])) !== '<p>a</p><script nonce="n">1</script><style nonce="n">b</style>') splits = false;
}
check("replaces the marker across every chunk boundary", splits);
check("a dangling partial marker is passed through", (await streamed(['tail nonce="0123'])) === 'tail nonce="0123');

const p = cspPolicy("abc", "/csp-report");
check("policy has the nonce, style-src-attr, and report-uri",
  p.includes("script-src 'self' 'nonce-abc'") && p.includes("style-src-attr 'unsafe-inline'") && p.endsWith("; report-uri /csp-report"));
check("nonces are 32 hex chars and differ", /^[0-9a-f]{32}$/.test(newNonce()) && newNonce() !== newNonce());

const html = applyCsp({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", "content-length": "9", [CSP_MARKER_HEADER]: M },
  body: `<script nonce="${M}"></script><script>raw</script>`,
});
const n = /nonce-([0-9a-f]{32})/.exec(html.headers["content-security-policy"])?.[1];
check("HTML result gets an enforced CSP whose nonce goes on the marked tag only",
  Boolean(n) && html.body === `<script nonce="${n}"></script><script>raw</script>` && !("content-length" in html.headers));
check("the marker header never leaves applyCsp", !Object.keys(html.headers).some((k) => k.toLowerCase() === CSP_MARKER_HEADER));
const unmarked = applyCsp({ status: 200, headers: { "content-type": "text/html", "content-length": "17" }, body: "<script></script>" });
check("HTML without a marker gets the policy and keeps its body (and length)",
  /nonce-/.test(unmarked.headers["content-security-policy"]) && unmarked.body === "<script></script>" && unmarked.headers["content-length"] === "17");
const badMarker = applyCsp({ status: 200, headers: { "content-type": "text/html", [CSP_MARKER_HEADER]: "" }, body: '<style nonce="">a{}</style>' });
check("an empty or malformed marker is ignored", badMarker.body === '<style nonce="">a{}</style>');
const json = { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
check("non-HTML results pass through", applyCsp(json) === json);
const own = { status: 200, headers: { "content-type": "text/html", "Content-Security-Policy": "default-src 'none'" }, body: "<script></script>" };
check("a result with its own CSP passes through", applyCsp(own) === own);
const ownMarked = applyCsp({ status: 200, headers: { "content-type": "text/html", "Content-Security-Policy": "default-src 'none'", [CSP_MARKER_HEADER]: M }, body: `<script nonce="${M}"></script>` });
check("with its own CSP the marked tags just lose the marker",
  ownMarked.headers["Content-Security-Policy"] === "default-src 'none'" && ownMarked.body === "<script ></script>" && !(CSP_MARKER_HEADER in ownMarked.headers));
const chunks = ["<p>x</p><script ", `nonce="${M.slice(0, 7)}`, `${M.slice(7)}" src="/a.js"></script>`];
const streamedResult = applyCsp({
  status: 200,
  headers: { "content-type": "text/html", [CSP_MARKER_HEADER]: M },
  stream: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }),
});
let streamedBody = "";
for await (const x of streamedResult.stream.pipeThrough(new TextDecoderStream())) streamedBody += x;
const sn = /nonce-([0-9a-f]{32})/.exec(streamedResult.headers["content-security-policy"])?.[1];
check("a streamed result gets the nonce on the marked tag", streamedBody === `<p>x</p><script nonce="${sn}" src="/a.js"></script>`);

// nonce.mjs: the marker exists only inside a render, and names itself on HTML results only.
check("cspOn follows NOWAKI_CSP", cspOn());
check("nonce() is empty outside a render", nonce() === "" && nonceAttr() === "");
let seen;
const result = await withCspMarker(async () => {
  await new Promise((r) => setTimeout(r, 1));
  seen = { n: nonce(), attr: nonceAttr() };
  return { status: 200, headers: { "content-type": "text/html", "X-Nowaki-Csp-Marker": "app-set" }, body: `<style${nonceAttr()}></style>` };
});
check("inside a render, nonce() is a 32-hex marker and nonceAttr() writes it",
  /^[0-9a-f]{32}$/.test(seen.n) && seen.attr === ` nonce="${seen.n}"`);
check("the HTML result names the render's marker (and drops an app-set one)",
  result.headers[CSP_MARKER_HEADER] === seen.n && !("X-Nowaki-Csp-Marker" in result.headers) && result.body === `<style nonce="${seen.n}"></style>`);
const [r1, r2] = await Promise.all([withCspMarker(async () => nonce()), withCspMarker(async () => nonce())]);
check("concurrent renders get different markers", r1 !== r2);
check("a non-HTML result names no marker", markResult(json, M) === json);
const sent = applyCsp(result);
const sentNonce = /nonce-([0-9a-f]{32})/.exec(sent.headers["content-security-policy"])?.[1];
check("end to end: the marked style gets the response's nonce, the marker is gone",
  sent.body === `<style nonce="${sentNonce}"></style>` && !sent.body.includes(seen.n));
delete process.env.NOWAKI_CSP;
check("with NOWAKI_CSP unset, cspOn is false", !cspOn());

console.log(failures ? `\nCSP TEST FAILED (${failures})` : "\nCSP TEST PASSED");
process.exit(failures ? 1 : 0);
