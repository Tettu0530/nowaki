// Remote images (`images.remotePatterns`, server/images-fetch.mjs): the pattern matcher against the
// fixture shared with nowaki-core, the address filter, then downloads from a local HTTP server
// (no network): success, deny, redirects (allowed, to a disallowed host, too many), the size cap,
// the timeout, non-images, private / loopback refusal. Then end to end with the nowaki binary on a
// scratch app: the build fetches and optimizes, a rebuild with the server gone uses the cache, a
// disallowed URL and a hostile redirect fail the build.
//
// The server listens on 127.0.0.1, which the fetcher refuses; the tests that need it set the
// test-only NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS flag (fetchImage's allowLoopback), which lets
// loopback through and nothing else.
//
// Usage: node scripts/images-fetch-test.mjs [path/to/nowaki]   (default target/debug/nowaki; the
// end-to-end part is skipped when the binary doesn't exist). PORT picks the server port (4870).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fetchImage, isAllowed, isBlockedAddress, parseRemoteUrl, sniff } from "../packages/nowaki-runtime/server/images-fetch.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 4870);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log(String(detail).slice(0, 2000));
  }
};
const rejects = async (p, re) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return re.test(e.message) ? true : e.message;
  }
};

// --- the shared pattern fixture ---
const fixture = JSON.parse(readFileSync(path.join(repo, "crates/nowaki-core/tests/fixtures/remote-patterns-cases.json"), "utf8"));
let mismatches = [];
let n = 0;
for (const g of fixture.groups) {
  for (const [url, want] of g.cases) {
    n++;
    if (isAllowed(url, g.patterns) !== want) mismatches.push(`${JSON.stringify(url)} → ${!want}`);
  }
}
check(`remotePatterns fixture (${n} cases)`, mismatches.length === 0, mismatches.join("\n"));
check("parse keeps the default port out", parseRemoteUrl("https://a.com:443/x")?.port === null);

// --- the address filter ---
const blocked = [
  "127.0.0.1", "127.255.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
  "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
  "::1", "::", "fe80::1", "fe80::1%en0", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
  "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001::1", "2001:db8::1", "::127.0.0.1", "not an ip",
];
const allowed = ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "2002:808:808::"];
const wrongBlocked = blocked.filter((a) => !isBlockedAddress(a));
const wrongAllowed = allowed.filter((a) => isBlockedAddress(a));
check("private, loopback, link-local, reserved addresses are blocked", wrongBlocked.length === 0, wrongBlocked.join(", "));
check("public addresses are allowed", wrongAllowed.length === 0, wrongAllowed.join(", "));
check("the test flag lets loopback through", !isBlockedAddress("127.0.0.1", true) && !isBlockedAddress("::1", true) && !isBlockedAddress("::ffff:127.0.0.1", true));
check("the test flag lets nothing else through", isBlockedAddress("10.0.0.1", true) && isBlockedAddress("169.254.169.254", true) && isBlockedAddress("fe80::1", true));

// --- formats ---
const png = readFileSync(path.join(repo, "examples/hello/photo.png"));
check("sniff: png / jpg / gif / webp, nothing else", sniff(png) === "png" && sniff(readFileSync(path.join(repo, "examples/hello/hero.jpg"))) === "jpg" && sniff(Buffer.from("GIF89a....")) === "gif" && sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")) === "webp" && sniff(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")) === null && sniff(Buffer.from("<html>")) === null);

// --- downloads from a local server ---
const hits = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
  switch (url.pathname) {
    case "/p/ok.png":
    case "/p/second.png":
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png);
    case "/p/redirect-ok":
      res.writeHead(302, { location: "/p/ok.png" });
      return res.end();
    case "/p/redirect-evil":
      res.writeHead(302, { location: "https://evil.test/p/ok.png" });
      return res.end();
    case "/p/redirect-outside":
      res.writeHead(301, { location: `${ORIGIN}/private/ok.png` });
      return res.end();
    case "/p/redirect-metadata":
      res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data" });
      return res.end();
    case "/p/loop": {
      const i = Number(url.searchParams.get("i") ?? 0);
      res.writeHead(302, { location: `/p/loop?i=${i + 1}` });
      return res.end();
    }
    case "/p/big.png": {
      // No content-length: the cap has to stop the stream.
      res.writeHead(200, { "content-type": "image/png" });
      res.write(png.subarray(0, 16));
      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 25 && !res.destroyed) {
          sent++;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      return pump();
    }
    case "/p/declared.png":
      res.writeHead(200, { "content-type": "image/png", "content-length": String(30 * 1024 * 1024) });
      return res.end(png.subarray(0, 16));
    case "/p/slow.png":
      res.writeHead(200, { "content-type": "image/png" });
      res.write(png.subarray(0, 16));
      return; // never ends
    case "/p/page.html":
      res.writeHead(200, { "content-type": "image/png" });
      return res.end("<html><script>alert(1)</script></html>");
    case "/p/vector.svg":
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>");
    default:
      res.writeHead(404);
      return res.end();
  }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const sockets = new Set();
server.on("connection", (s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-images-"));
const patterns = [
  { protocol: "http", hostname: "127.0.0.1", port: String(PORT), pathname: "/p/**" },
  { protocol: "http", hostname: "localhost", port: String(PORT), pathname: "/p/**" },
  // Allowed by the patterns, refused by the address check.
  { protocol: "http", hostname: "169.254.169.254" },
  { protocol: "http", hostname: "10.0.0.1" },
];
const loop = { allowLoopback: true };
let k = 0;
const req = (url) => ({ url, dir: path.join(tmp, String(k++)), stem: "img" });

try {
  const ok = req(`${ORIGIN}/p/ok.png`);
  const meta = await fetchImage(ok, patterns, loop);
  check("downloads an allowed image", meta.file === "img.png" && readFileSync(path.join(ok.dir, "img.png")).equals(png), JSON.stringify(meta));
  const written = JSON.parse(readFileSync(path.join(ok.dir, "meta.json"), "utf8"));
  check("meta.json names the URL and the file", written.url === ok.url && written.file === "img.png" && written.type === "image/png");

  check("refuses a URL the patterns don't allow (no request)", (await rejects(fetchImage(req(`${ORIGIN}/private/ok.png`), patterns, loop), /not allowed/)) === true && !hits.has("/private/ok.png"));
  check("follows a redirect to an allowed URL", (await fetchImage(req(`${ORIGIN}/p/redirect-ok`), patterns, loop)).finalUrl === `${ORIGIN}/p/ok.png`);
  check("refuses a redirect to a disallowed host", (await rejects(fetchImage(req(`${ORIGIN}/p/redirect-evil`), patterns, loop), /redirect to https:\/\/evil\.test\/p\/ok\.png is not allowed/)) === true);
  check("refuses a redirect outside the allowed path (no request)", (await rejects(fetchImage(req(`${ORIGIN}/p/redirect-outside`), patterns, loop), /not allowed/)) === true && !hits.has("/private/ok.png"));
  check("refuses a redirect to the metadata address even when the patterns allow it", (await rejects(fetchImage(req(`${ORIGIN}/p/redirect-metadata`), patterns, loop), /169\.254\.169\.254 is a private or loopback address/)) === true);
  const loopHits = () => hits.get("/p/loop") ?? 0;
  check("stops after 3 redirects", (await rejects(fetchImage(req(`${ORIGIN}/p/loop`), patterns, loop), /more than 3 redirects/)) === true && loopHits() === 4, loopHits());

  const big = req(`${ORIGIN}/p/big.png`);
  const r = await rejects(fetchImage(big, patterns, loop), /larger than 20 MB/);
  check("aborts a streamed body past 20 MB", r === true, r);
  check("an aborted download leaves no file", !existsSync(path.join(big.dir, "img.png")));
  check("refuses a declared length past the cap", (await rejects(fetchImage(req(`${ORIGIN}/p/declared.png`), patterns, loop), /larger than 20 MB/)) === true);
  const t0 = Date.now();
  const slow = await rejects(fetchImage(req(`${ORIGIN}/p/slow.png`), patterns, { ...loop, timeoutMs: 300 }), /timed out after 0\.3 s/);
  check("times out", slow === true && Date.now() - t0 < 5000, slow);
  check("refuses a body that isn't an image (HTML)", (await rejects(fetchImage(req(`${ORIGIN}/p/page.html`), patterns, loop), /not a PNG, JPEG, WebP or GIF/)) === true);
  check("refuses SVG", (await rejects(fetchImage(req(`${ORIGIN}/p/vector.svg`), patterns, loop), /not a PNG, JPEG, WebP or GIF/)) === true);
  check("reports HTTP errors", (await rejects(fetchImage(req(`${ORIGIN}/p/missing.png`), patterns, loop), /HTTP 404/)) === true);

  // Without the test flag the local server is off limits, by IP and by name.
  const before = hits.get("/p/ok.png");
  check("refuses a loopback IP", (await rejects(fetchImage(req(`${ORIGIN}/p/ok.png`), patterns), /127\.0\.0\.1 is a private or loopback address/)) === true);
  check("refuses a name that resolves to loopback", (await rejects(fetchImage(req(`http://localhost:${PORT}/p/ok.png`), patterns), /localhost resolves to a private or loopback address/)) === true);
  check("refuses a private IP the patterns allow", (await rejects(fetchImage(req("http://10.0.0.1/x.png"), patterns, loop), /10\.0\.0\.1 is a private or loopback address/)) === true);
  check("no request reached the server without the flag", hits.get("/p/ok.png") === before);

  // The script itself, as the CLI runs it (async: this process also runs the server).
  const cli = (requests, env = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(repo, "packages/nowaki-runtime/server/images-fetch.mjs")], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", () => resolve({ stdout, stderr }));
      child.stdin.end(JSON.stringify({ patterns, requests }));
    });
  const a = req(`${ORIGIN}/p/second.png`);
  const b = req(`${ORIGIN}/p/redirect-evil`);
  const out = await cli([a, b], { NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS: "1" });
  const res = JSON.parse(out.stdout || "[]");
  check("CLI: one result per request", res.length === 2 && res[0].ok === true && /not allowed/.test(res[1].error), out.stdout + out.stderr);
  check("CLI: the failed request's directory is removed", !existsSync(b.dir));
  check("CLI: warns when the test flag is set", /NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS/.test(out.stderr));
  const off = JSON.parse((await cli([req(`${ORIGIN}/p/second.png`)])).stdout || "[]");
  check("CLI: loopback refused without the flag", /private or loopback/.test(off[0]?.error ?? ""), JSON.stringify(off));

  await endToEnd();
} finally {
  for (const s of sockets) s.destroy();
  server.close();
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}

async function endToEnd() {
  const bin = path.resolve(process.argv[2] ?? path.join(repo, "target/debug", process.platform === "win32" ? "nowaki.exe" : "nowaki"));
  if (!existsSync(bin)) {
    console.log(`skip end-to-end: ${bin} not found`);
    return;
  }
  const helloModules = path.join(repo, "examples/hello/node_modules");
  const app = path.join(repo, "target/images-fetch-e2e");
  rmSync(app, { recursive: true, force: true });
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    writeFileSync(path.join(app, rel), text);
  };
  write("package.json", JSON.stringify({ name: "images-e2e", private: true, type: "module" }));
  symlinkSync(helloModules, path.join(app, "node_modules"), "junction");
  write(
    "nowaki.config.mjs",
    `export default { images: { remotePatterns: [{ protocol: "http", hostname: "127.0.0.1", port: "${PORT}", pathname: "/p/**" }] } };\n`,
  );
  // A token per run, so the shared cache (examples/hello/node_modules/.cache) never has these yet.
  const run = `${process.pid}-${Date.now()}`;
  const url = `${ORIGIN}/p/ok.png?run=${run}`;
  const mdUrl = `${ORIGIN}/p/second.png?run=${run}`;
  write(
    "routes/index.tsx",
    `import { Image } from "@nowaki-dev/runtime/image";
import photo from "${url}&image&w=64,128";
export default function Index() {
  return <main><Image src={photo} alt="remote" /></main>;
}
`,
  );
  write("routes/post.mdx", `# Post\n\n![from mdx](${mdUrl})\n`);
  const cacheDirs = [url, mdUrl].map((u) => path.join(helloModules, ".cache/nowaki/images/remote", createHash("sha256").update(u).digest("hex")));
  const build = (env = {}) =>
    new Promise((resolve) => {
      const child = spawn(bin, ["build", app], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      child.on("close", (code) => resolve({ code, log }));
    });
  try {
    const first = await build({ NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS: "1" });
    check("e2e: the build fetches remote images", first.code === 0, first.log);
    const client = existsSync(path.join(app, "dist/client")) ? readdirSync(path.join(app, "dist/client")) : [];
    check("e2e: AVIF and fallback variants for the ?image import", client.some((f) => /^ok-64\..*\.avif$/.test(f)) && client.some((f) => /^ok-128\..*\.png$/.test(f)), client.join(" "));
    check("e2e: the MDX image is optimized too", client.some((f) => /^second-\d+\..*\.avif$/.test(f)), client.join(" "));
    const page = existsSync(path.join(app, "dist/server/routes/index.js")) ? readFileSync(path.join(app, "dist/server/routes/index.js"), "utf8") : "";
    check("e2e: the page module points at local variants, not the remote URL", page.includes("ok-64.") && !page.includes("127.0.0.1"), page.slice(0, 1500));
    check("e2e: one request per image", hits.get("/p/ok.png") >= 1 && cacheDirs.every((d) => existsSync(path.join(d, "meta.json"))));

    // A rebuild works from the cache alone: no request reaches the server.
    const before = [...hits.values()].reduce((a, b) => a + b, 0);
    const second = await build({ NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS: "1" });
    const after = [...hits.values()].reduce((a, b) => a + b, 0);
    check("e2e: a rebuild uses the cache (no request)", second.code === 0 && after === before, second.log);

    // nowaki dev: a miss is fetched when the module is transformed; variants come from /__nowaki/image.
    const devUrl = `${ORIGIN}/p/second.png?run=${run}-dev`;
    cacheDirs.push(path.join(helloModules, ".cache/nowaki/images/remote", createHash("sha256").update(devUrl).digest("hex")));
    write("routes/index.tsx", `import { Image } from "@nowaki-dev/runtime/image";\nimport photo from "${devUrl}&image";\nexport default () => <main><Image src={photo} alt="dev" /></main>;\n`);
    const devPort = PORT + 1;
    const dev = spawn(bin, ["dev", app, "--port", String(devPort)], {
      env: { ...process.env, NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let devLog = "";
    dev.stdout.on("data", (d) => (devLog += d));
    dev.stderr.on("data", (d) => (devLog += d));
    try {
      let html = "";
      for (let i = 0; i < 60 && !html; i++) {
        html = await fetch(`http://127.0.0.1:${devPort}/`).then((r) => (r.ok ? r.text() : ""), () => "");
        if (!html) await new Promise((r) => setTimeout(r, 500));
      }
      const variant = html.match(/\/__nowaki\/image\?f=[^" ,]+fmt=avif/)?.[0]?.replaceAll("&amp;", "&");
      check("dev: the page renders the remote image from the cache", !!variant && variant.includes("/node_modules/.cache/nowaki/images/remote/"), html.slice(0, 1500) + devLog);
      check("dev: a miss is fetched once", hits.get("/p/second.png") >= 1 && existsSync(path.join(cacheDirs.at(-1), "meta.json")));
      const img = variant ? await fetch(`http://127.0.0.1:${devPort}${variant}`) : null;
      check("dev: /__nowaki/image serves the variant", img?.status === 200 && img.headers.get("content-type") === "image/avif", img?.status);
    } finally {
      dev.kill();
      await new Promise((r) => dev.once("close", r));
    }

    // Without the test flag, a miss to loopback fails the build.
    const missUrl = `${ORIGIN}/p/ok.png?run=${run}-miss`;
    write("routes/index.tsx", `import photo from "${missUrl}&image";\nexport default () => <img src={photo.src} />;\n`);
    cacheDirs.push(path.join(helloModules, ".cache/nowaki/images/remote", createHash("sha256").update(missUrl).digest("hex")));
    const refused = await build();
    check("e2e: a loopback fetch fails the build without the flag", refused.code !== 0 && /private or loopback/.test(refused.log), refused.log);

    write("routes/index.tsx", `import photo from "${ORIGIN}/private/a.png?image";\nexport default () => <img src={photo.src} />;\n`);
    const denied = await build({ NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS: "1" });
    check("e2e: a URL the patterns don't allow fails the build", denied.code !== 0 && /not allowed by images\.remotePatterns/.test(denied.log) && !hits.has("/private/a.png"), denied.log);

    const evilUrl = `${ORIGIN}/p/redirect-evil?run=${run}`;
    write("routes/index.tsx", `import photo from "${evilUrl}&image";\nexport default () => <img src={photo.src} />;\n`);
    const redirected = await build({ NOWAKI_IMAGES_ALLOW_LOOPBACK_FOR_TESTS: "1" });
    check("e2e: a redirect to a disallowed host fails the build", redirected.code !== 0 && /redirect to https:\/\/evil\.test/.test(redirected.log), redirected.log);
  } finally {
    try { rmSync(app, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
    for (const d of cacheDirs) try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nimages-fetch: all checks passed");
