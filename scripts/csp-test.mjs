// Unit test for server/csp.mjs (the adapters' CSP): nonce injection in strings and across stream
// chunks, policy, and applyCsp's pass-through rules.
// Usage: node scripts/csp-test.mjs
process.env.NOWAKI_CSP = "enforce";
const { injectNonce, nonceTransform, cspPolicy, applyCsp, newNonce } = await import(
  "../packages/nowaki-runtime/server/csp.mjs"
);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

check("script and style tags get the nonce",
  injectNonce('<style>a{}</style><script type="module" src="/x.js"></script><SCRIPT>1</SCRIPT>', "n") ===
    '<style nonce="n">a{}</style><script nonce="n" type="module" src="/x.js"></script><SCRIPT nonce="n">1</SCRIPT>');
check("other tags are untouched",
  injectNonce("<scripts></scripts><styled-x></styled-x><p>&lt;script&gt;</p>", "n") ===
    "<scripts></scripts><styled-x></styled-x><p>&lt;script&gt;</p>");

async function streamed(chunks) {
  const rs = new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  }).pipeThrough(nonceTransform("n"));
  let out = "";
  for await (const x of rs) out += x;
  return out;
}
check("injects across chunk boundaries",
  (await streamed(["<p>a</p><scr", "ipt>1</script><sty", "le", ">b</style>"])) ===
    '<p>a</p><script nonce="n">1</script><style nonce="n">b</style>');
check("a dangling partial tag is passed through", (await streamed(["tail <scri"])) === "tail <scri");

const p = cspPolicy("abc", "/csp-report");
check("policy has the nonce, style-src-attr, and report-uri",
  p.includes("script-src 'self' 'nonce-abc'") && p.includes("style-src-attr 'unsafe-inline'") && p.endsWith("; report-uri /csp-report"));
check("nonces are 32 hex chars and differ", /^[0-9a-f]{32}$/.test(newNonce()) && newNonce() !== newNonce());

const html = applyCsp({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-length": "9" }, body: "<script></script>" });
const n = /nonce-([0-9a-f]{32})/.exec(html.headers["content-security-policy"])?.[1];
check("HTML result gets an enforced CSP whose nonce matches the body",
  Boolean(n) && html.body === `<script nonce="${n}"></script>` && !("content-length" in html.headers));
const json = { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
check("non-HTML results pass through", applyCsp(json) === json);
const own = { status: 200, headers: { "content-type": "text/html", "Content-Security-Policy": "default-src 'none'" }, body: "<script></script>" };
check("a result with its own CSP passes through", applyCsp(own) === own);

console.log(failures ? `\nCSP TEST FAILED (${failures})` : "\nCSP TEST PASSED");
process.exit(failures ? 1 : 0);
