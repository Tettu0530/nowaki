// The dev toolbar in a real browser (Chrome over CDP) on `nowaki dev` under NOWAKI_CSP=enforce:
// it shows the route, the islands (client vs live, the could-be-live hint), the first-load JS
// against the budget, ISR settings, Jetstream connections, and an error after a broken edit with
// an editor link (NOWAKI_EDITOR); it updates after a client navigation and after an HMR page
// update; the close button keeps it hidden in this browser; a 403 from the devtools endpoint (a
// LAN client under --host) removes it; no CSP violation anywhere. Then `nowaki dev --no-toolbar`
// renders data-toolbar="0" and the toolbar never loads.
// Builds a small app under target/ (linked to examples/hello's node_modules).
//   PORT=5520 CDP_PORT=5521 node scripts/toolbar-browser-test.mjs
// NOWAKI_BIN overrides the binary (default target/debug/nowaki), CHROME the browser.

import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT || 5520);
const CDP_PORT = Number(process.env.CDP_PORT || 5521);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failures++;
};

const FILES = {
  "package.json": `{ "name": "toolbar-browser-test", "private": true, "type": "module" }\n`,
  "routes/_layout.tsx": `export default function Layout({ children }: { children: unknown }) {
  return <div id="layout"><nav><a id="to-other" href="/other">other</a> <a id="to-home" href="/">home</a></nav>{children}</div>;
}\n`,
  "routes/index.tsx": `import Counter from "../islands/Counter.tsx";
import LiveCount from "../islands/LiveCount.tsx";
export const budget = { js: 40 };
export const revalidate = 30;
export const tags = ["home"];
export async function loader() { await new Promise((r) => setTimeout(r, 3)); return { at: 1 }; }
export default function Home() {
  return <main><h1 id="title">home</h1><Counter /><LiveCount /></main>;
}\n`,
  "routes/other.tsx": `import Badge from "../islands/Badge.tsx";
export default function Other() { return <main><h1 id="other">other page</h1><Badge /></main>; }\n`,
  "islands/Counter.tsx": `import { useState } from "preact/hooks";
export default function Counter() {
  const [n, setN] = useState(0);
  return <button id="inc" onClick={() => setN(n + 1)}>count {n}</button>;
}\n`,
  "islands/Badge.tsx": `export default function Badge() { return <b id="badge">badge</b>; }\n`,
  "islands/LiveCount.tsx": `export const live = { state: () => ({ n: 0 }), on: { inc: (s: { n: number }) => ({ n: s.n + 1 }) } };
export default function LiveCount({ state }: { state: { n: number } }) {
  return <div><span id="live">live {state.n}</span><button data-live="inc">+</button></div>;
}\n`,
};

mkdirSync(path.join(ROOT, "target"), { recursive: true });
const tmp = mkdtempSync(path.join(ROOT, "target", "toolbar-browser-test-"));
const profile = mkdtempSync(path.join(os.tmpdir(), "nowaki-toolbar-chrome-"));
const children = new Set();
const removeDirs = () => {
  for (const dir of [tmp, profile]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {}
  }
};
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(5000)]);
  }
  children.delete(child);
}
process.on("exit", () => {
  for (const c of children) c.kill("SIGKILL");
  removeDirs();
});
process.on("SIGINT", () => process.exit(130));

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
    this.cspLogs = 0;
    this.onEvent = null;
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(e);
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") console.log("  page exception:", msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error" && !/favicon/.test(msg.params.entry.url ?? "")) {
        console.log("  page log:", msg.params.entry.text, msg.params.entry.url ?? "");
        if (/Content Security Policy/.test(msg.params.entry.text)) this.cspLogs++;
      }
      if (msg.method && this.onEvent) this.onEvent(msg);
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

async function waitFor(cdp, expr, ms = 8000) {
  for (let i = 0; i < ms / 50; i++) {
    try {
      if (await cdp.eval(`return !!(${expr});`)) return true;
    } catch {}
    await sleep(50);
  }
  return false;
}

// The toolbar's shadow root, and a query inside it.
const TB = `document.querySelector("nowaki-toolbar")?.shadowRoot`;
const q = (sel) => `${TB}?.querySelector(${JSON.stringify(sel)})`;
const panelText = () => `(${q(".body")}?.textContent ?? "")`;

async function startDev(dir, args, env) {
  const server = spawn(BIN, ["dev", dir, "--port", String(PORT), ...args], { stdio: ["ignore", "inherit", "inherit"], env });
  children.add(server);
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    up = await fetch(`${BASE}/`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`nowaki dev did not listen on ${PORT}`);
  return server;
}

async function startChrome(name) {
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(profile, name)}`, "about:blank"]);
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
  await cdp.send("Log.enable");
  return { chrome, cdp };
}

async function go(cdp, p) {
  await cdp.send("Page.navigate", { url: BASE + p });
  await sleep(300);
  await waitFor(cdp, `document.readyState === "complete"`);
  await marks(cdp);
}

async function marks(cdp) {
  await cdp.eval(`window.__sameDoc = 1; window.__violations ??= [];
    addEventListener("securitypolicyviolation", (e) => window.__violations.push(e.violatedDirective + " " + e.blockedURI));
    return true;`);
}

function writeApp(dir) {
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(dir, "node_modules"));
}

const tab = (id) => `${q(`[data-tab="${id}"]`)}?.click()`;

async function main() {
  const dir = path.join(tmp, "app");
  writeApp(dir);
  const server = await startDev(dir, [], { ...process.env, NOWAKI_CSP: "enforce", NOWAKI_EDITOR: "cursor", NOWAKI_TOOLBAR: "" });
  const { chrome, cdp } = await startChrome("main");

  await go(cdp, "/");
  check("the toolbar mounts (outside <body>, in a shadow root)", await waitFor(cdp, `${TB} && document.querySelector("nowaki-toolbar").parentElement === document.documentElement`));
  check("collapsed at first: the pill names the route", await waitFor(cdp, `${q(".pill")}?.textContent.includes("/") && ${q(".panel")}.hidden`));
  await cdp.eval(`${q(".pill")}.click(); return true;`);
  check("the pill opens the panel (aria-expanded)", await waitFor(cdp, `!${q(".panel")}.hidden && ${q(".pill")}.getAttribute("aria-expanded") === "true"`));
  check("the panel shows the route file", await waitFor(cdp, `${q(".title")}.textContent.includes("routes/index.tsx")`), await cdp.eval(`return ${q(".title")}?.textContent;`));
  check("page tab: the root layout", await waitFor(cdp, `${panelText()}.includes("routes/_layout.tsx")`));
  check(
    "page tab: Server-Timing of the navigation (loader, render)",
    await waitFor(cdp, `${q("[data-timings]")}?.textContent.includes("loader") && ${q("[data-timings]")}.textContent.includes("render")`),
    await cdp.eval(`return ${panelText()};`),
  );
  check("source links use NOWAKI_EDITOR (cursor://)", await waitFor(cdp, `${q('a[data-source="routes/index.tsx"]')}?.href.startsWith("cursor://file/")`), await cdp.eval(`return ${q("a[data-source]")}?.href;`));

  await cdp.eval(`${tab("islands")}; return true;`);
  check("islands tab: Counter is a hydrated client island with a could-be-live hint", await waitFor(cdp, `(() => { const li = ${q('li[data-island="Counter"]')}; return li?.dataset.kind === "client" && li.textContent.includes("hydrated") && li.textContent.includes("could be live") && /KB gzip/.test(li.textContent); })()`), await cdp.eval(`return ${panelText()};`));
  check("islands tab: LiveCount is a live island (no client JS)", await waitFor(cdp, `${q('li[data-island="LiveCount"]')}?.dataset.kind === "live" && ${q('li[data-island="LiveCount"]')}.textContent.includes("no client JS")`));

  await cdp.eval(`${tab("js")}; return true;`);
  check(
    "JS tab: first-load estimate within the 40 KB budget",
    await waitFor(cdp, `/[0-9.]+ KB gzip/.test(${q("[data-budget]")}?.textContent) && ${q("[data-budget]")}.textContent.includes("estimate") && ${q("[data-budget]")}.textContent.includes("within budget 40 KB")`),
    await cdp.eval(`return ${panelText()};`),
  );
  check("JS tab: no build yet", (await cdp.eval(`return ${panelText()};`)).includes("no nowaki build output"));

  await cdp.eval(`${tab("isr")}; return true;`);
  check("ISR tab: revalidate and tags, cached under nowaki start", await waitFor(cdp, `${q("[data-revalidate]")}?.textContent === "30 s" && ${panelText()}.includes("home") && ${panelText()}.includes("nowaki start")`), await cdp.eval(`return ${panelText()};`));

  check(
    "live tab: the page's Jetstream connection",
    await waitFor(cdp, `(${tab("live")}, Number(${q("[data-live-connections]")}?.textContent) >= 1)`, 10000),
    await cdp.eval(`return ${panelText()};`),
  );

  // Keyboard: arrow keys move between tabs, Escape collapses and focuses the pill.
  await cdp.eval(`${q('[data-tab="live"]')}.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); return true;`);
  check("ArrowRight moves to the next tab", await waitFor(cdp, `${q('[data-tab="errors"]')}?.getAttribute("aria-selected") === "true"`));
  await cdp.eval(`${q(".panel")}.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
  check("Escape collapses the panel", await waitFor(cdp, `${q(".panel")}.hidden && ${TB}.activeElement === ${q(".pill")}`));
  await cdp.eval(`${q(".pill")}.click(); ${tab("page")}; return true;`);

  // A client navigation: the toolbar follows (route + the router's Server-Timing).
  await cdp.eval(`const a = document.getElementById("to-other"); a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return true;`);
  await sleep(300);
  await cdp.eval(`document.getElementById("to-other").click(); return true;`);
  check("SPA navigation to /other", await waitFor(cdp, `location.pathname === "/other" && document.getElementById("other") && window.__sameDoc === 1`));
  check("after the SPA navigation: the toolbar shows routes/other.tsx", await waitFor(cdp, `${q(".title")}?.textContent.includes("routes/other.tsx")`), await cdp.eval(`return ${q(".title")}?.textContent;`));
  check("after the SPA navigation: timings from the router's response", await waitFor(cdp, `${panelText()}.includes("Timings (navigation)") && ${q("[data-timings]")}?.textContent.includes("render")`), await cdp.eval(`return ${panelText()};`));
  await cdp.eval(`${tab("islands")}; return true;`);
  check("after the SPA navigation: Badge (needs no JS)", await waitFor(cdp, `${q('li[data-island="Badge"]')}?.textContent.includes("needs no JS")`), await cdp.eval(`return ${panelText()};`));

  // An HMR page update (a route edit): rendered in place, and the toolbar refetches.
  await sleep(500);
  const other = path.join(dir, "routes/other.tsx");
  const good = readFileSync(other, "utf8");
  writeFileSync(other, good.replace("other page", "other page 2").replace("export default", "export const revalidate = 7;\nexport default"));
  check("HMR page update rendered in place", await waitFor(cdp, `document.getElementById("other")?.textContent === "other page 2" && window.__sameDoc === 1`));
  await cdp.eval(`${tab("isr")}; return true;`);
  check("after the HMR page update: the toolbar shows the new revalidate", await waitFor(cdp, `${q("[data-revalidate]")}?.textContent === "7 s"`), await cdp.eval(`return ${panelText()};`));
  await cdp.eval(`${tab("page")}; return true;`);
  check("after the HMR page update: timings of the refetch", await waitFor(cdp, `${panelText()}.includes("HMR page update") && ${panelText()}.includes("Last HMR update: page")`), await cdp.eval(`return ${panelText()};`));

  // A broken edit: the error page, with the toolbar on it pointing at the file.
  writeFileSync(other, good.replace("export default function Other() {", "export default function Other() {{ <"));
  check("broken edit: the dev error page", await waitFor(cdp, `!window.__sameDoc && /error/i.test(document.title)`, 10000), await cdp.eval("return document.title;"));
  await marks(cdp);
  check("the toolbar is on the error page, flagged red", await waitFor(cdp, `document.querySelector("nowaki-toolbar")?.getAttribute("data-status") === "bad"`, 10000), await cdp.eval(`return document.querySelector("nowaki-toolbar")?.getAttribute("data-status");`));
  await cdp.eval(`${tab("errors")}; return true;`);
  check(
    "errors tab: the build error with an editor link to routes/other.tsx",
    await waitFor(cdp, `[...(${TB}?.querySelectorAll('li[data-error] a[data-source]') ?? [])].some((a) => a.dataset.source.startsWith("routes/other.tsx") && a.href.startsWith("cursor://file/") && a.href.includes("/routes/other.tsx"))`),
    await cdp.eval(`return ${panelText()};`),
  );
  writeFileSync(other, good);
  check("fixed: the page is back", await waitFor(cdp, `document.getElementById("other")?.textContent === "other page"`, 10000));
  await marks(cdp);

  // A LAN client under --host gets 403 from the endpoint: the toolbar removes itself.
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*__nowaki/devtools*" }] });
  cdp.onEvent = (msg) => {
    if (msg.method === "Fetch.requestPaused") {
      cdp.send("Fetch.fulfillRequest", { requestId: msg.params.requestId, responseCode: 403, body: Buffer.from("forbidden").toString("base64") }).catch(() => {});
    }
  };
  await go(cdp, "/");
  check("a 403 from /__nowaki/devtools hides the toolbar", await waitFor(cdp, `performance.getEntriesByType("resource").some((e) => e.name.includes("/__nowaki/devtools")) && !document.querySelector("nowaki-toolbar")`));
  await cdp.send("Fetch.disable");
  cdp.onEvent = null;

  // The close button: hidden in this browser from then on, until the key is removed.
  await go(cdp, "/");
  check("the toolbar is back (panel open as left)", await waitFor(cdp, `${q(".panel")} && !${q(".panel")}.hidden`));
  await cdp.eval(`${q('[data-action="close"]')}.click(); return true;`);
  check("close removes it and remembers", await waitFor(cdp, `!document.querySelector("nowaki-toolbar") && localStorage.getItem("nowaki:toolbar") === "off"`));
  await go(cdp, "/");
  await sleep(2500);
  check(
    "closed: not loaded on the next page load",
    await cdp.eval(`return !document.querySelector("nowaki-toolbar") && !performance.getEntriesByType("resource").some((e) => e.name.includes("toolbar.js"));`),
  );
  await cdp.eval(`localStorage.removeItem("nowaki:toolbar"); return true;`);
  await go(cdp, "/");
  check("with the key removed it comes back", await waitFor(cdp, TB));

  const violations = await cdp.eval("return window.__violations;");
  check("no CSP violations (NOWAKI_CSP=enforce)", violations.length === 0, violations.join(", "));
  check("no CSP violation logged in any document", cdp.cspLogs === 0, String(cdp.cspLogs));

  cdp.ws.close();
  await stop(chrome);
  await stop(server);
}

// `nowaki dev --no-toolbar`: the hmr script says data-toolbar="0" and toolbar.js never loads.
async function off() {
  const dir = path.join(tmp, "off");
  writeApp(dir);
  const server = await startDev(dir, ["--no-toolbar"], { ...process.env, NOWAKI_TOOLBAR: "" });
  const html = await (await fetch(`${BASE}/`)).text();
  check("--no-toolbar: data-toolbar=\"0\" on the hmr script", /<script type="module" src="[^"]*\/client\/hmr\.js" data-toolbar="0"><\/script>/.test(html));
  const { chrome, cdp } = await startChrome("off");
  await go(cdp, "/");
  check("--no-toolbar: the page hydrated", await waitFor(cdp, `document.getElementById("inc")`));
  await sleep(2500);
  check(
    "--no-toolbar: no toolbar, toolbar.js not requested",
    await cdp.eval(`return !document.querySelector("nowaki-toolbar") && !performance.getEntriesByType("resource").some((e) => e.name.includes("toolbar.js"));`),
  );
  cdp.ws.close();
  await stop(chrome);
  await stop(server);
}

try {
  await main();
  await off();
} catch (e) {
  console.error(e);
  failures++;
}

for (const c of [...children]) await stop(c);
removeDirs();
console.log(failures ? `\nTOOLBAR BROWSER TEST FAILED (${failures})` : "\nTOOLBAR BROWSER TEST PASSED");
process.exit(failures ? 1 : 0);
