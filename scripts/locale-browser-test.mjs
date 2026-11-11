// Locale detection (nowaki.config `i18n.detect`) in a real browser (Chrome over CDP): a click on a
// <Link locale> inside an island sets the nowaki_locale cookie before the router navigates, and the
// next request for `/` follows it instead of Accept-Language. Builds a small app into a temp
// directory (linked to examples/hello's node_modules) and serves it with `nowaki start`.
//   PORT=5070 CDP_PORT=5090 node scripts/locale-browser-test.mjs
// NOWAKI_BIN overrides the binary (default target/debug/nowaki), CHROME the browser.

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT || 8251);
const CDP_PORT = Number(process.env.CDP_PORT || 9225);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failures++;
};

const FILES = {
  "package.json": `{ "name": "locale-browser-test", "private": true, "type": "module" }\n`,
  "nowaki.config.mjs": `export default { i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true } };\n`,
  "routes/index.tsx": `import { getLocale } from "@nowaki-dev/runtime";
export default function Home() { return <main id="home">{\`HOME \${getLocale()}\`}</main>; }\n`,
  "routes/switch.tsx": `import Switcher from "../islands/Switcher.tsx";
export default function Switch() { return <main><Switcher /></main>; }\n`,
  "islands/Switcher.tsx": `import { useEffect, useState } from "preact/hooks";
import { href, Link } from "@nowaki-dev/runtime/navigation";
export default function Switcher() {
  // Rendered only in the browser, so these hrefs come from the client's reading of <html>.
  const [later, setLater] = useState(false);
  useEffect(() => { setLater(true); }, []);
  useEffect(() => { if (later) document.body.dataset.ready = "1"; }, [later]);
  return (
    <nav>
      <Link href="/" locale="ja">ja</Link> <Link href="/" locale="en">en</Link>
      {later && <Link id="later" href="/switch">later</Link>}
      {later && <form id="later-form" action={href("/switch")}></form>}
    </nav>
  );
}\n`,
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-locale-browser-"));
// Chrome's profile gets its own directory: Chrome keeps writing to it for a moment after SIGKILL,
// which made removing `tmp` race (ENOTEMPTY).
const profile = mkdtempSync(path.join(os.tmpdir(), "nowaki-locale-chrome-"));
const children = new Set();
// Best-effort: a leftover temp dir never changes the exit code.
const removeDirs = () => {
  for (const dir of [tmp, profile]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {}
  }
};
// Kill the children and wait (bounded) for them to exit, so nothing still writes to the
// directories while they are removed.
async function stopChildren() {
  const exits = [...children].map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once("exit", r))));
  for (const c of children) c.kill("SIGKILL");
  await Promise.race([Promise.all(exits), sleep(5000)]);
  children.clear();
}
process.on("exit", () => {
  for (const c of children) c.kill("SIGKILL");
  removeDirs();
});
process.on("SIGINT", () => process.exit(130));

// Each package linked to its real directory (see rules-e2e.mjs: Windows junction caveat).
function linkModules(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === ".bin" || name === ".cache") continue;
    const src = path.join(from, name);
    if (name.startsWith("@") && statSync(src).isDirectory() && !lstatSync(src).isSymbolicLink()) {
      linkModules(src, path.join(to, name));
      continue;
    }
    symlinkSync(realpathSync(src), path.join(to, name), "junction");
  }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(e);
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

async function waitFor(cdp, expr, ms = 10000) {
  for (let i = 0; i < ms / 100; i++) {
    try {
      if (await cdp.eval(`return !!(${expr});`)) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

const state = (cdp) =>
  cdp.eval(`return { path: location.pathname, home: document.getElementById("home")?.textContent ?? "", cookie: document.cookie };`);

try {
  const dir = path.join(tmp, "app");
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(dir, "node_modules"));
  const built = spawnSync(BIN, ["build", dir], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`nowaki build failed:\n${built.stdout}${built.stderr}`);

  const server = spawn(BIN, ["start", dir, "--port", String(PORT)], { stdio: ["ignore", "inherit", "inherit"] });
  children.add(server);
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    up = await fetch(`${BASE}/switch`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`nowaki start did not listen on ${PORT}`);

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);
  children.add(chrome);
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page");
    } catch {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`Chrome exposed no page target on CDP port ${CDP_PORT} (CHROME=${CHROME})`);
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  const go = async (p) => {
    await cdp.send("Page.navigate", { url: BASE + p });
    await sleep(300);
    await waitFor(cdp, `document.readyState === "complete"`);
  };
  const language = (value) => cdp.send("Network.setExtraHTTPHeaders", { headers: { "Accept-Language": value } });

  // Without the cookie, Accept-Language decides.
  await language("ja");
  await go("/");
  let s = await state(cdp);
  check("no cookie: Accept-Language ja on / lands on /ja", s.path === "/ja" && s.home === "HOME ja", JSON.stringify(s));

  // A visitor whose browser prefers English picks Japanese in an island.
  await cdp.send("Network.clearBrowserCookies");
  await language("en");
  await go("/switch");
  check("the island hydrated", await waitFor(cdp, `document.body.dataset.ready === "1"`));
  const later = () => cdp.eval(`return [document.getElementById("later")?.getAttribute("href"), document.getElementById("later-form")?.getAttribute("action")].join(" ");`);
  let l = await later();
  check("client: <Link> and href() in the default locale add no prefix", l === "/switch /switch", l);
  await cdp.eval(`document.querySelector('a[hreflang="ja"]').click(); return true;`);
  await waitFor(cdp, `location.pathname === "/ja"`);
  s = await state(cdp);
  check("<Link locale=ja> sets nowaki_locale=ja and goes to /ja", /(^|; )nowaki_locale=ja(;|$)/.test(s.cookie) && s.path === "/ja", JSON.stringify(s));
  await go("/");
  s = await state(cdp);
  check("the next / follows the cookie, not Accept-Language en", s.path === "/ja" && s.home === "HOME ja", JSON.stringify(s));

  // And back: a Japanese browser picks English, and / stops redirecting to /ja.
  await language("ja");
  await go("/ja/switch");
  check("the island hydrated under /ja", await waitFor(cdp, `document.body.dataset.ready === "1"`));
  l = await later();
  check("client: <Link> and href() keep the page's locale", l === "/ja/switch /ja/switch", l);
  await cdp.eval(`document.querySelector('a[hreflang="en"]').click(); return true;`);
  await sleep(500);
  s = await state(cdp);
  check("<Link locale=en> sets nowaki_locale=en", /(^|; )nowaki_locale=en(;|$)/.test(s.cookie), JSON.stringify(s));
  await go("/");
  s = await state(cdp);
  check("the next / stays on the default locale despite Accept-Language ja", s.path === "/" && s.home === "HOME en", JSON.stringify(s));
} catch (e) {
  console.error(e);
  failures++;
}

await stopChildren();
removeDirs();
console.log(failures ? `\nLOCALE BROWSER TEST FAILED (${failures})` : "\nLOCALE BROWSER TEST PASSED");
process.exit(failures ? 1 : 0);
