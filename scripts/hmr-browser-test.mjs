// HMR in a real browser (Chrome over CDP) on `nowaki dev`: Fast Refresh keeps island state across
// edits, a new hook remounts, an edited util reaches the island, a live (Jetstream) island keeps
// its server state, and global CSS / a CSS Module / an island's plain CSS change with no
// navigation. Runs twice: without a CSP and under NOWAKI_CSP=enforce. Prints the update latency
// (file written -> DOM updated) for each kind of edit.
// Builds a small app under target/ (linked to examples/hello's node_modules).
//   PORT=5500 CDP_PORT=5501 node scripts/hmr-browser-test.mjs
// NOWAKI_BIN overrides the binary (default target/debug/nowaki), CHROME the browser.

import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT || 5500);
const CDP_PORT = Number(process.env.CDP_PORT || 5501);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failures++;
};

const FILES = {
  "package.json": `{ "name": "hmr-browser-test", "private": true, "type": "module" }\n`,
  "routes/_layout.tsx": `import "../styles/global.css";
export default function Layout({ children }: { children: unknown }) { return <div id="layout">{children}</div>; }\n`,
  "routes/index.tsx": `import Counter from "../islands/Counter.tsx";
import Styled from "../islands/Styled.tsx";
export default function Home() { return <main><h1 id="title">HMR</h1><Counter /><Styled /></main>; }\n`,
  "routes/live.tsx": `import LiveCount from "../islands/LiveCount.tsx";
export default function Live() { return <main><LiveCount /></main>; }\n`,
  "styles/global.css": `#title { color: rgb(1, 2, 3); }\n`,
  "lib/label.ts": `export const label = (s: string) => s;\n`,
  "islands/Counter.tsx": `import { useEffect, useState } from "preact/hooks";
import { label } from "../lib/label.ts";
export default function Counter() {
  const [n, setN] = useState(0);
  useEffect(() => { document.body.dataset.hydrated = "1"; }, []);
  return (
    <div>
      <span id="count">{label("count")}: {n}</span>
      <button id="inc" onClick={() => setN((c) => c + 1)}>+</button>
    </div>
  );
}\n`,
  "islands/Styled.tsx": `import s from "./Styled.module.css";
import "./plain.css";
export default function Styled() { return <p id="styled" class={s.box}><b id="plain">plain</b></p>; }\n`,
  "islands/Styled.module.css": `.box { color: rgb(10, 10, 10); }\n`,
  "islands/plain.css": `#plain { color: rgb(20, 20, 20); }\n`,
  "islands/LiveCount.tsx": `export const live = { state: () => ({ n: 0 }), on: { inc: (s: { n: number }) => ({ n: s.n + 1 }) } };
export default function LiveCount({ state }: { state: { n: number } }) {
  return <div><span id="live">live {state.n}</span><button id="live-inc" data-live="inc">+</button></div>;
}\n`,
};

// Inside the repository: dev serves dependencies outside the app root (the pnpm store) only from
// the workspace around it.
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const tmp = mkdtempSync(path.join(ROOT, "target", "hmr-browser-test-"));
// Chrome's profile gets its own directory (Chrome keeps writing to it for a moment after SIGKILL).
const profile = mkdtempSync(path.join(os.tmpdir(), "nowaki-hmr-chrome-"));
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
      // Page errors show up in the log (they explain a failed check).
      if (msg.method === "Runtime.exceptionThrown") console.log("  page exception:", msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        console.log("  page console.error:", msg.params.args.map((a) => a.value ?? a.description).join(" "));
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error" && !/favicon/.test(msg.params.entry.url ?? "")) {
        console.log("  page log:", msg.params.entry.text, msg.params.entry.url ?? "");
      }
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
  // Runs a fixed function in the page with `args` passed as values (not spliced into source).
  async call(fn, ...args) {
    const g = await this.send("Runtime.evaluate", { expression: "globalThis" });
    const r = await this.send("Runtime.callFunctionOn", {
      objectId: g.result.objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

async function waitFor(cdp, expr, ms = 6000) {
  for (let i = 0; i < ms / 50; i++) {
    try {
      if (await cdp.eval(`return !!(${expr});`)) return true;
    } catch {}
    await sleep(50);
  }
  return false;
}

const latencies = {};

// Edits `file` and waits until `expr` holds in the page. A MutationObserver (plus a check on
// each `nowaki:hmr` event and stylesheet load) stamps when it first held, so the latency doesn't
// include this script's polling.
async function edit(cdp, dir, file, from, to, expr, kind) {
  const abs = path.join(dir, file);
  const text = readFileSync(abs, "utf8");
  if (!text.includes(from)) throw new Error(`${file} has no ${JSON.stringify(from)}`);
  await cdp.eval(`
    window.__hit = 0;
    const probe = () => { if (!window.__hit && (${expr})) window.__hit = Date.now(); };
    window.__probe?.disconnect();
    window.__probe = new MutationObserver(probe);
    window.__probe.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    addEventListener("nowaki:hmr", probe);
    document.addEventListener("load", probe, true);
    return true;`);
  const t0 = Date.now();
  writeFileSync(abs, text.replace(from, to));
  const ok = await waitFor(cdp, `window.__hit || (${expr})`);
  const hit = await cdp.eval("return window.__hit;");
  const ms = ok && hit ? hit - t0 : null;
  if (ms !== null) (latencies[kind] ??= []).push(ms);
  return ok;
}

async function run(mode) {
  const dir = path.join(tmp, mode);
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(dir, "node_modules"));
  const env = { ...process.env, NOWAKI_CSP: mode === "csp" ? "enforce" : "" };
  if (mode !== "csp") delete env.NOWAKI_CSP;
  const server = spawn(BIN, ["dev", dir, "--port", String(PORT)], { stdio: ["ignore", "inherit", "inherit"], env });
  children.add(server);
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    up = await fetch(`${BASE}/`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`nowaki dev did not listen on ${PORT}`);

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${path.join(profile, mode)}`,
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
  await cdp.send("Log.enable");
  const go = async (p) => {
    await cdp.send("Page.navigate", { url: BASE + p });
    await sleep(300);
    await waitFor(cdp, `document.readyState === "complete"`);
    // Marks this document: a reload or navigation drops it.
    await cdp.eval(`window.__sameDoc = 1; window.__violations = [];
      addEventListener("securitypolicyviolation", (e) => window.__violations.push(e.violatedDirective + " " + e.blockedURI));
      return true;`);
  };
  const text = (id) => cdp.call((id) => document.getElementById(id)?.textContent ?? null, id);
  const color = (id) =>
    cdp.call((id) => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).color : null;
    }, id);
  const click = (id, times = 1) =>
    cdp.call((id, times) => {
      for (let i = 0; i < times; i++) document.getElementById(id).click();
      return true;
    }, id, times);
  const tag = `[${mode}]`;

  await go("/");
  check(`${tag} the island hydrated`, await waitFor(cdp, `document.body.dataset.hydrated === "1"`));
  // Wait for the HMR socket too, or the first edit's message can arrive before it is open.
  await sleep(500);
  await click("inc", 3);
  check(`${tag} counter at 3`, await waitFor(cdp, `document.getElementById("count")?.textContent === "count: 3"`), await text("count"));

  // Edit the island's JSX: the text changes, the state stays.
  let ok = await edit(cdp, dir, "islands/Counter.tsx", `{label("count")}: {n}`, `{label("clicks")}: {n}`, `document.getElementById("count")?.textContent === "clicks: 3"`, "island JSX");
  check(`${tag} island JSX edit: text changed, count still 3`, ok, await text("count"));

  // An edited util the island imports: the island renders it, state kept.
  ok = await edit(cdp, dir, "lib/label.ts", "(s: string) => s;", "(s: string) => s.toUpperCase();", `document.getElementById("count")?.textContent === "CLICKS: 3"`, "imported util");
  check(`${tag} util edit: island updated, count still 3`, ok, await text("count"));

  // A new hook changes the signature: the island remounts (state resets).
  ok = await edit(cdp, dir, "islands/Counter.tsx", "const [n, setN] = useState(0);", "const [n, setN] = useState(0);\n  const [m] = useState(7);", `document.getElementById("count")?.textContent === "CLICKS: 0"`, "new hook (remount)");
  check(`${tag} added hook: remounted (count back to 0)`, ok, await text("count"));
  await click("inc", 2);
  check(`${tag} the remounted island still works`, await waitFor(cdp, `document.getElementById("count")?.textContent === "CLICKS: 2"`), await text("count"));

  // CSS: the layout's global stylesheet (a <link>), a CSS Module and plain CSS an island imports
  // (<style> shims).
  check(`${tag} global.css applied`, (await color("title")) === "rgb(1, 2, 3)", await color("title"));
  ok = await edit(cdp, dir, "styles/global.css", "rgb(1, 2, 3)", "rgb(4, 5, 6)", `getComputedStyle(document.getElementById("title")).color === "rgb(4, 5, 6)"`, "global CSS (link)");
  check(`${tag} global.css edit: computed color changed`, ok, await color("title"));
  const links = await cdp.eval(`return [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => l.href.includes("global.css")).length;`);
  check(`${tag} the old global.css <link> is gone`, links === 1, String(links));
  check(`${tag} CSS Module applied`, (await color("styled")) === "rgb(10, 10, 10)", await color("styled"));
  ok = await edit(cdp, dir, "islands/Styled.module.css", "rgb(10, 10, 10)", "rgb(11, 12, 13)", `getComputedStyle(document.getElementById("styled")).color === "rgb(11, 12, 13)"`, "CSS Module rule");
  check(`${tag} CSS Module edit: computed color changed`, ok, await color("styled"));
  ok = await edit(cdp, dir, "islands/plain.css", "rgb(20, 20, 20)", "rgb(21, 22, 23)", `getComputedStyle(document.getElementById("plain")).color === "rgb(21, 22, 23)"`, "island plain CSS");
  check(`${tag} island plain CSS edit: computed color changed`, ok, await color("plain"));
  // A renamed class: the island gets the new class map.
  ok = await edit(cdp, dir, "islands/Styled.module.css", ".box {", ".frame {", `getComputedStyle(document.getElementById("styled")).color !== "rgb(11, 12, 13)"`, "CSS Module class rename");
  check(`${tag} CSS Module class rename: the old class no longer styles`, ok, await color("styled"));
  ok = await edit(cdp, dir, "islands/Styled.tsx", "s.box", "s.frame", `/frame/.test(document.getElementById("styled").className) && getComputedStyle(document.getElementById("styled")).color === "rgb(11, 12, 13)"`, "island JSX");
  check(`${tag} island using the renamed class: styled again (it got the new class map)`, ok, await color("styled"));

  check(`${tag} no navigation happened`, (await cdp.eval("return window.__sameDoc === 1 && performance.getEntriesByType('navigation').length === 1;")) === true);
  check(`${tag} count kept through the CSS edits`, (await text("count")) === "CLICKS: 2", await text("count"));
  const violations = await cdp.eval("return window.__violations;");
  check(`${tag} no CSP violations`, violations.length === 0, violations.join(", "));

  // A live (Jetstream) island: its server state survives an edit, and the socket renders the
  // new code afterwards.
  await go("/live");
  check(`${tag} live island rendered`, await waitFor(cdp, `document.getElementById("live")?.textContent === "live 0"`), await text("live"));
  await sleep(500);
  await click("live-inc");
  await waitFor(cdp, `document.getElementById("live")?.textContent === "live 1"`);
  await click("live-inc");
  check(`${tag} live island at 2`, await waitFor(cdp, `document.getElementById("live")?.textContent === "live 2"`), await text("live"));
  ok = await edit(cdp, dir, "islands/LiveCount.tsx", "live {state.n}", "LIVE {state.n}", `document.getElementById("live")?.textContent === "LIVE 2"`, "live island");
  check(`${tag} live island edit: new markup, state 2 kept`, ok, await text("live"));
  await click("live-inc");
  check(`${tag} the next live event renders the new code from state 2`, await waitFor(cdp, `document.getElementById("live")?.textContent === "LIVE 3"`), await text("live"));
  check(`${tag} no navigation on /live`, (await cdp.eval("return window.__sameDoc === 1;")) === true);
  const liveViolations = await cdp.eval("return window.__violations;");
  check(`${tag} no CSP violations on /live`, liveViolations.length === 0, liveViolations.join(", "));

  // A route edit still reloads the page (until routes re-render in place).
  await cdp.eval("window.__sameDoc = 1; return true;");
  writeFileSync(path.join(dir, "routes/live.tsx"), readFileSync(path.join(dir, "routes/live.tsx"), "utf8").replace("<main>", '<main id="edited">'));
  check(`${tag} route edit: the page reloads with it`, await waitFor(cdp, `!window.__sameDoc && document.getElementById("edited")`));

  cdp.ws.close();
  await stop(chrome);
  await stop(server);
}

try {
  await run("plain");
  await run("csp");
} catch (e) {
  console.error(e);
  failures++;
}

for (const c of [...children]) await stop(c);
removeDirs();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log("\nHMR latency (file written -> DOM updated), ms:");
for (const [kind, xs] of Object.entries(latencies)) {
  console.log(`  ${kind.padEnd(24)} median ${String(median(xs)).padStart(4)}  [${xs.join(", ")}]`);
}
console.log(failures ? `\nHMR BROWSER TEST FAILED (${failures})` : "\nHMR BROWSER TEST PASSED");
process.exit(failures ? 1 : 0);
