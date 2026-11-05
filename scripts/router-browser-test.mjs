// Client router behavior test in a real browser (Chrome).
// Runs in CI (browser job) and locally. Drives Chrome directly over CDP (no puppeteer).
// Usage: BASE=http://127.0.0.1:8233 node scripts/router-browser-test.mjs
import { spawn } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:8233";
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}

// A single CDP session. Thin wrapper that runs in-page JS via Runtime.evaluate.
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
    "--user-data-dir=/tmp/nwk-chrome-test",
    "about:blank",
  ]);
  let targets;
  // Chrome can take a while to start on CI runners; wait up to 30s for a page target.
  for (let i = 0; i < 120; i++) {
    try {
      targets = await cdpTargets();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error(`Chrome exposed no page target over CDP within 30s (CHROME=${CHROME})`);
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  await cdp.send("Page.navigate", { url: BASE + "/" });
  await sleep(800);

  // The router loads on intent only: nothing has hovered, focused, or clicked a link yet, so its
  // chunk must not have been fetched.
  const routerLoaded = () =>
    cdp.evalAsync(`return performance.getEntriesByType('resource').some((r) => /\\/_nowaki\\/router\\.[0-9a-f]+\\.js/.test(r.name));`);
  check("the router isn't downloaded on page load", (await routerLoaded()) === false && (await cdp.evalAsync(`return !window.__nowakiRouter;`)));

  // SPA navigation: create a link and click it (the router intercepts)
  await cdp.evalAsync(`
    window.__nav = (href) => { const a=document.createElement('a'); a.href=href; a.textContent=href; document.body.appendChild(a); a.click(); };
    return true;`);
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(500);
  const afterAbout = await cdp.evalAsync(`
    return { path: location.pathname, h1: document.querySelector('h1')?.textContent || '', hasIslandRuntime: !!window.__nowakiRouter };`);
  check("SPA navigation swapped to /about", afterAbout.path === "/about" && /About/i.test(afterAbout.h1));

  // Router Cache: go back, then /about again. Fetch count doesn't grow
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(400);
  const fetchesBefore = await cdp.evalAsync(`
    return performance.getEntriesByType('resource').filter(e=>e.name.endsWith('/about')&&e.initiatorType==='fetch').length;`);
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(400);
  const after = await cdp.evalAsync(`
    return { path: location.pathname,
      fetches: performance.getEntriesByType('resource').filter(e=>e.name.endsWith('/about')&&e.initiatorType==='fetch').length };`);
  check(
    "Router Cache served revisit without a new fetch",
    after.path === "/about" && after.fetches === fetchesBefore,
  );

  // loading boundary
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(400);
  await cdp.evalAsync(`window.__nav('/slow?ms=700'); return true;`);
  await sleep(300); // past the 150ms threshold, 700ms loader not done yet
  const duringLoad = await cdp.evalAsync(`
    return { hasLoading: !!document.querySelector('[data-testid="loading"]'), hasSlow: !!document.querySelector('[data-testid="slow"]') };`);
  check("loading boundary shows during a slow navigation", duringLoad.hasLoading && !duringLoad.hasSlow);
  await sleep(800);
  const afterSlow = await cdp.evalAsync(`
    return { hasSlow: !!document.querySelector('[data-testid="slow"]'), hasLoading: !!document.querySelector('[data-testid="loading"]') };`);
  check("slow page replaces the loading boundary once loaded", afterSlow.hasSlow && !afterSlow.hasLoading);

  // error boundary: block the fetch -> fallback shown -> reset recovers
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(400);
  // The Router Cache would serve it, so block a different URL (?e=1 is uncached)
  await cdp.send("Network.setBlockedURLs", { urls: ["*/about?e=1*", "*/about\\?e=1*", "*about?e=1*"] });
  await cdp.evalAsync(`window.__nav('/about?e=1'); return true;`);
  await sleep(700);
  const errState = await cdp.evalAsync(`
    return { hasError: !!document.querySelector('[data-testid="error"]'),
             msg: document.querySelector('[data-nowaki-error]')?.textContent || '',
             hasReset: !!document.querySelector('[data-nowaki-reset]') };`);
  check("error boundary shows on a failed navigation", errState.hasError && errState.hasReset && errState.msg.length > 0);
  await cdp.send("Network.setBlockedURLs", { urls: [] });
  await cdp.evalAsync(`document.querySelector('[data-nowaki-reset]').click(); return true;`);
  await sleep(700);
  const afterReset = await cdp.evalAsync(`
    return { path: location.pathname + location.search, hasAbout: /About/i.test(document.querySelector('h1')?.textContent||'') };`);
  check("reset retries and recovers the page", afterReset.hasAbout);

  // <head> styles and <html lang> follow the page on client navigation (and are dropped when leaving)
  // A style injected at runtime (as CSS-in-JS libraries do) is outside the page's head region.
  await cdp.evalAsync(`const s = document.createElement('style'); s.id = 'runtime-css'; document.head.appendChild(s); return true;`);
  await cdp.evalAsync(`window.__nav('/styled'); return true;`);
  await sleep(600);
  check("runtime-injected <style> survives client navigation", await cdp.evalAsync(`return !!document.getElementById('runtime-css');`));
  const styled = await cdp.evalAsync(`
    return { path: location.pathname, lang: document.documentElement.lang,
             color: getComputedStyle(document.getElementById('styled-probe') || document.body).color };`);
  check("client navigation applies the target page's <style>", styled.path === "/styled" && styled.color === "rgb(1, 2, 3)");
  check("client navigation applies the target page's <html lang>", styled.lang === "ja");
  // htmlAttrs / bodyAttrs follow too; an attribute client code set (not in data-nowaki-attrs) stays.
  const attrs = await cdp.evalAsync(`
    return { rev: document.documentElement.getAttribute('data-sheet-rev'), body: document.body.className,
             site: document.body.dataset.site };`);
  check(`client navigation applies htmlAttrs / bodyAttrs (${JSON.stringify(attrs)})`,
    attrs.rev === "3" && attrs.body === "site styled-page" && attrs.site === "hello");
  // Route CSS: the page's <link rel="stylesheet"> comes with the head swap and applies.
  await sleep(200);
  const linked = await cdp.evalAsync(`return getComputedStyle(document.getElementById('styled-linked') || document.body).color;`);
  check("client navigation applies the target page's linked stylesheet", linked === "rgb(4, 5, 6)");
  await cdp.evalAsync(`document.documentElement.setAttribute('data-client', '1'); window.__nav('/about'); return true;`);
  await sleep(600);
  const leftAttrs = await cdp.evalAsync(`
    return { rev: document.documentElement.getAttribute('data-sheet-rev'), body: document.body.className,
             client: document.documentElement.getAttribute('data-client') };`);
  check(`leaving drops the page's htmlAttrs, keeps the layout's and client-set ones (${JSON.stringify(leftAttrs)})`,
    leftAttrs.rev === null && leftAttrs.body === "site" && leftAttrs.client === "1");
  const left = await cdp.evalAsync(`
    return { lang: document.documentElement.lang,
             stale: [...document.head.querySelectorAll('style')].some((s) => s.textContent.includes('styled-probe')),
             staleLink: [...document.head.querySelectorAll('link[rel=stylesheet]')].some((l) => l.href.includes('/styled.')) };`);
  check("leaving drops the previous page's <style> and restores lang", !left.stale && left.lang === "en");
  check("leaving drops the previous page's linked stylesheet", !left.staleLink);

  console.log(`\n${failures === 0 ? "BROWSER ROUTER TEST PASSED" : `BROWSER ROUTER TEST FAILED (${failures})`}`);
} catch (err) {
  console.error("harness error:", err);
  failures++;
} finally {
  if (chrome) chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
