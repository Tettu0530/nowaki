// Jetstream in a real browser (Chrome over CDP, no puppeteer): clicking data-live buttons on /live
// updates the island, over the transport the page is expected to pick; /live-form covers submit,
// debounced input, change, and keyed rows.
// Usage: BASE=http://127.0.0.1:8243 EXPECT=post [PAGE=/live] node scripts/live-browser-test.mjs   (EXPECT=ws|post)
import { spawn } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:8243";
const EXPECT = process.env.EXPECT || "post";
const PAGE = process.env.PAGE || "/live";
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT || 9224);

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
    `--user-data-dir=/tmp/nwk-chrome-live-test-${PORT}`,
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

  // Reached by a client (SPA) navigation, the page's live islands must work too: the first visit
  // from a page without live islands has to load live.js, the second has to join the new islands
  // on the socket that's already open.
  const spaNav = async (href) => {
    await cdp.evalAsync(`const a = document.createElement('a'); a.href = ${JSON.stringify(href)}; a.textContent = 'go';
      document.body.appendChild(a); a.click(); return true;`);
    await sleep(1200);
    return cdp.evalAsync("return { path: location.pathname, router: !!window.__nowakiRouter };");
  };
  await cdp.send("Page.navigate", { url: BASE + "/" });
  await sleep(1000);
  for (const visit of ["first", "second"]) {
    const nav = await spaNav(PAGE);
    check(`${visit} SPA visit to ${PAGE} went through the router`, nav.path === PAGE && nav.router);
    const before = Number(await count());
    await click("inc");
    await sleep(800);
    check(`${visit} SPA visit: + updates the island (${before} → ${await count()})`, Number(await count()) === before + 1);
    await spaNav("/");
  }

  // Form, input, and change events on /live-form, over the same transport.
  await cdp.send("Page.navigate", { url: BASE + "/live-form" });
  await sleep(1000);
  const add = (text) =>
    cdp.evalAsync(`const f = document.querySelector('nowaki-live form[data-live-submit]');
      f.querySelector('[name=text]').value = ${JSON.stringify(text)}; f.requestSubmit(); return true;`);
  const items = () => cdp.evalAsync(`return [...document.querySelectorAll('[data-testid=todo-list] li')].map((li) => li.textContent.trim());`);
  await add("milk");
  await sleep(600);
  check(`data-live-submit adds a todo (${JSON.stringify(await items())})`, JSON.stringify(await items()) === '["milk"]');
  check("the page didn't navigate on submit", (await cdp.evalAsync("return location.pathname;")) === "/live-form");
  await cdp.evalAsync("window.__milk = document.querySelector('[data-testid=todo-list] li'); return true;");
  await add("bread");
  await sleep(600);
  check(`new todo goes first (${JSON.stringify(await items())})`, JSON.stringify(await items()) === '["bread","milk"]');
  check("keyed morph keeps the existing row's element",
    await cdp.evalAsync("return document.querySelector('[data-testid=todo-list] li[data-key=\"1\"]') === window.__milk;"));
  await cdp.evalAsync("document.querySelector('[data-testid=todo-list] li[data-key=\"1\"] input').click(); return true;");
  await sleep(600);
  check("data-live-change toggles the checkbox state on the server",
    await cdp.evalAsync("return document.querySelector('[data-testid=todo-list] li[data-key=\"1\"] input').checked === true;"));
  await cdp.evalAsync(`const i = document.querySelector('[data-testid=todo-filter]'); i.focus(); i.value = 'br';
    i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await sleep(700);
  check(`data-live-input filters after the debounce (${JSON.stringify(await items())})`, JSON.stringify(await items()) === '["bread"]');
  check("the focused input keeps what was typed",
    (await cdp.evalAsync("return document.querySelector('[data-testid=todo-filter]').value;")) === "br");

  // Rooms (WebSocket only: POST has no push or presence): two tabs on /poll share the votes.
  if (EXPECT === "ws") {
    await cdp.send("Page.navigate", { url: BASE + "/poll" });
    const second = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${BASE}/poll`, { method: "PUT" })).json();
    const tab2 = new CDP(second.webSocketDebuggerUrl);
    await tab2.ready;
    await tab2.send("Runtime.enable");
    await sleep(1500);
    const votes = (c) => c.evalAsync("return document.querySelector('[data-testid=votes]')?.textContent ?? null;");
    const here = (c) => c.evalAsync("return document.querySelector('[data-nowaki-presence=\"poll:demo\"]')?.textContent ?? null;");
    check(`room presence shows both tabs (${await here(cdp)}, ${await here(tab2)})`, (await here(cdp)) === "2" && (await here(tab2)) === "2");
    const before = await votes(tab2);
    await cdp.evalAsync("document.querySelector('nowaki-live [data-live=vote][value=a]').click(); return true;");
    await sleep(800);
    const after = await votes(tab2);
    const a = (t) => Number(/a:\s*(\d+)/.exec(t ?? "")?.[1]);
    check(`a vote in one tab shows up in the other (${before} → ${after})`, a(after) === a(before) + 1);
    await tab2.send("Page.close").catch(() => {});

    // Leaving a live page by client navigation tears its islands down: the socket closes, so
    // another tab sees the connection count drop (nowaki:presence without a room).
    const third = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${BASE}/live`, { method: "PUT" })).json();
    const tab3 = new CDP(third.webSocketDebuggerUrl);
    await tab3.ready;
    await tab3.send("Runtime.enable");
    await sleep(1500);
    await tab3.evalAsync(`window.__online = null;
      addEventListener('nowaki:presence', (e) => { if (e.detail.room === undefined) window.__online = e.detail.count; });
      return true;`);
    const online = () => tab3.evalAsync("return window.__online;");
    await cdp.send("Page.navigate", { url: BASE + "/live" });
    await sleep(1500);
    const withBoth = await online();
    const nav = await spaNav("/");
    await sleep(500);
    check(`SPA navigation away from /live leaves (presence ${withBoth} → ${await online()})`,
      nav.router && typeof withBoth === "number" && (await online()) === withBoth - 1);
    await tab3.send("Page.close").catch(() => {});
  }

  console.log(`\n${failures === 0 ? "LIVE BROWSER TEST PASSED" : `LIVE BROWSER TEST FAILED (${failures})`}`);
} catch (err) {
  console.error("harness error:", err);
  failures++;
} finally {
  if (chrome) chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
