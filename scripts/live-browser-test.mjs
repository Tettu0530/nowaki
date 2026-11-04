// Jetstream in a real browser (Chrome over CDP, no puppeteer): clicking data-live buttons on /live
// updates the island, over the transport the page is expected to pick.
// Usage: BASE=http://127.0.0.1:8243 EXPECT=post [PAGE=/live] node scripts/live-browser-test.mjs   (EXPECT=ws|post)
import { spawn } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:8243";
const EXPECT = process.env.EXPECT || "post";
const PAGE = process.env.PAGE || "/live";
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9224;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async evalAsync(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

let chrome;
let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

try {
  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=/tmp/nwk-chrome-live-test",
    "about:blank",
  ]);
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
    } catch {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`Chrome exposed no page target over CDP within 30s (CHROME=${CHROME})`);
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: BASE + PAGE });
  await sleep(1000);

  const count = () =>
    cdp.evalAsync(`return /live:\\s*(-?\\d+)/.exec(document.querySelector('nowaki-live')?.textContent || '')?.[1] ?? null;`);
  const click = (h) => cdp.evalAsync(`document.querySelector('nowaki-live [data-live="${h}"]').click(); return true;`);

  check("island starts at 0", (await count()) === "0");
  await click("inc");
  await click("inc");
  await sleep(800);
  check("two clicks on + → live: 2", (await count()) === "2");
  await click("dec");
  await sleep(500);
  check("then - → live: 1", (await count()) === "1");
  const posts = await cdp.evalAsync(
    `return performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/__nowaki/live-event')).length;`,
  );
  check(`events went over ${EXPECT} (${posts} POSTs)`, EXPECT === "post" ? posts === 3 : posts === 0);

  console.log(`\n${failures === 0 ? "LIVE BROWSER TEST PASSED" : `LIVE BROWSER TEST FAILED (${failures})`}`);
} catch (err) {
  console.error("harness error:", err);
  failures++;
} finally {
  if (chrome) chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
