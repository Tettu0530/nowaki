// Client router behavior test in a real browser (Chrome).
// Runs in CI (browser job) and locally. Drives Chrome directly over CDP (no puppeteer), through
// --remote-debugging-pipe: no debugging port to collide with, and a fresh profile directory per
// run (CI runs this twice in a row; a fixed port and profile could still be held by the previous
// Chrome while it shut down, and the new one then exposed no page target).
// Usage: BASE=http://127.0.0.1:8233 node scripts/router-browser-test.mjs
// For an app built with nowaki.config `basePath`, put the base in BASE
// (BASE=http://127.0.0.1:8233/app): the paths below are then checked under it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.env.BASE || "http://127.0.0.1:8233").replace(/\/$/, "");
// The basePath in BASE ("" without one). In the page, __P is it and __path() the path without it.
const P = new URL(BASE).pathname.replace(/\/$/, "");
const PRELUDE = `const __P = ${JSON.stringify(P)}; const __path = () => (__P && location.pathname.startsWith(__P) ? location.pathname.slice(__P.length) || "/" : location.pathname);`;
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CDP over Chrome's --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-separated JSON), attached to
// the page with a flat session. Runs in-page JS via Runtime.evaluate.
class CDP {
  constructor(input, output) {
    this.input = input;
    this.id = 0;
    this.pending = new Map();
    this.events = []; // CDP events (method + params), for checks on requests the page made
    this.session = undefined;
    let buf = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(buf.slice(0, end));
        buf = buf.slice(end + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      }
    });
  }
  send(method, params = {}, sessionId = this.session) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + "\0");
    });
  }
  async evalAsync(expr) {
    const r = await this.send("Runtime.evaluate", {
      // Paths in the checks are route paths: under a basePath, links get it and locations lose it.
      expression: `(async () => { ${PRELUDE} ${expr.replaceAll("location.pathname", "__path()").replaceAll("a.href=href;", "a.href=href.startsWith('/')?__P+href:href;")} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  // Polls `expr` (an expression, through evalAsync) until it is truthy or `ms` pass. A page that
  // is still loading (evaluate fails between documents) counts as not yet.
  async waitFor(expr, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await this.evalAsync(`return !!(${expr});`)) return true;
      } catch {}
      await sleep(50);
    }
    return false;
  }
  // A full load of `url`: waits for the new document to finish loading and islands.js to run
  // (its hydrate hook is set), instead of a fixed sleep.
  async load(url) {
    await this.send("Page.navigate", { url });
    if (!(await this.waitFor(`document.readyState === "complete" && location.href !== "about:blank" && window.__nowakiHydrateIslands`, 20000))) {
      throw new Error(`${url} did not finish loading`);
    }
  }
}

let chrome;
let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const profile = mkdtempSync(path.join(os.tmpdir(), "nowaki-router-chrome-"));

try {
  chrome = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const exited = new Promise((r) => chrome.once("exit", r));
  const cdp = new CDP(chrome.stdio[3], chrome.stdio[4]);
  let page;
  // Chrome can take a while to start on CI runners: wait up to 30s for the page target. Each
  // Target.getTargets is raced against 250 ms, since Chrome may not answer before it is up.
  const deadline = Date.now() + 30000;
  while (!page && Date.now() < deadline) {
    const r = await Promise.race([cdp.send("Target.getTargets", {}, null).catch(() => null), sleep(250), exited.then(() => "exited")]);
    if (r === "exited") throw new Error(`Chrome exited during startup (CHROME=${CHROME})`);
    page = r?.targetInfos?.find((t) => t.type === "page");
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`Chrome exposed no page target over CDP within 30s (CHROME=${CHROME})`);
  cdp.session = (await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, null)).sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  await cdp.load(BASE + "/");

  // The router loads on intent only: nothing has hovered, focused, or clicked a link yet, so its
  // chunk must not have been fetched.
  const routerLoaded = () =>
    cdp.evalAsync(`return performance.getEntriesByType('resource').some((r) => /\\/_nowaki\\/router\\.[0-9a-f]+\\.js/.test(r.name));`);
  check("the router isn't downloaded on page load", (await routerLoaded()) === false && (await cdp.evalAsync(`return !window.__nowakiRouter;`)));

  // SPA navigation: create a link and click it (the router intercepts)
  await cdp.evalAsync(`
    window.__nav = (href) => { const a=document.createElement('a'); a.href=href; a.textContent=href; document.body.appendChild(a); a.click(); };
    return true;`);
  // The first click comes before the router is there: islands.js loads its chunk, then replays the
  // click as a client navigation. That takes a fetch of the chunk and one of the page, so wait for
  // the swap (and that it was a swap, not a full load: the same document) rather than a fixed time.
  await cdp.evalAsync(`window.__sameDoc = 1; window.__nav('/about'); return true;`);
  await cdp.waitFor(`location.pathname === "/about" && /About/i.test(document.querySelector('h1')?.textContent ?? '') && window.__nowakiRouter`);
  const afterAbout = await cdp.evalAsync(`
    return { path: location.pathname, h1: document.querySelector('h1')?.textContent || '', hasIslandRuntime: !!window.__nowakiRouter, same: window.__sameDoc === 1 };`);
  check(`SPA navigation swapped to /about (${JSON.stringify(afterAbout)})`, afterAbout.path === "/about" && /About/i.test(afterAbout.h1) && afterAbout.same);

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
  await cdp.evalAsync(`const s = document.createElement('style'); s.id = 'runtime-css'; s.nonce = window.__nowakiNonce ?? ''; document.head.appendChild(s);
    window.__cspViolations = []; addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));
    return true;`);
  await cdp.evalAsync(`window.__nav('/styled'); return true;`);
  await sleep(600);
  // Under NOWAKI_CSP the fetched page's <style> (another response's nonce) is parsed with this
  // document's nonce, so DOMParser reports nothing.
  const cspViolations = await cdp.evalAsync(`return window.__cspViolations;`);
  check(`no CSP violations navigating to /styled (${cspViolations.join(", ")})`, cspViolations.length === 0);
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

  // Page scripts: loaded on client navigation, and nowaki:page-load lets a script that already ran
  // set up the page again when it comes back.
  await cdp.evalAsync(`window.__nav('/scripted'); return true;`);
  await sleep(800);
  const stamp1 = await cdp.evalAsync(`return document.getElementById('script-stamp')?.textContent ?? null;`);
  check(`client navigation loads the page's script (${JSON.stringify(stamp1)})`, stamp1 === "page script ran");
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(500);
  await cdp.evalAsync(`window.__nav('/scripted'); return true;`);
  await sleep(800);
  const stamp2 = await cdp.evalAsync(`return { text: document.getElementById('script-stamp')?.textContent ?? null,
    tags: document.querySelectorAll('script[data-nowaki-script][src*="stamp"]').length };`);
  check(`coming back re-runs it through nowaki:page-load, loading it once (${JSON.stringify(stamp2)})`,
    stamp2.text === "page script ran" && stamp2.tags === 1);

  // Back/forward restores the scroll of the page returned to, not of the page left.
  const targetTop = (sel) => `return Math.round(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect().top ?? -1);`;
  await cdp.evalAsync(`window.__nav('/anchors'); return true;`);
  await sleep(800);
  await cdp.evalAsync(`scrollTo(0, 1234); return true;`);
  await sleep(100);
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(500);
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(600);
  const backY = await cdp.evalAsync(`return { path: location.pathname, y: scrollY };`);
  check(`back restores the scroll of the page returned to (${JSON.stringify(backY)})`, backY.path === "/anchors" && backY.y === 1234);

  // Hash-only history entries: back/forward between them keeps the document (island state) and
  // doesn't fetch, and scroll follows the entry.
  await cdp.evalAsync(`
    document.querySelectorAll('main button')[1].click();
    document.querySelector('main').dataset.keep = '1';
    scrollTo(0, 500); return true;`);
  await sleep(100);
  const anchorFetches = () =>
    cdp.evalAsync(`return performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === __P + '/anchors' && e.initiatorType === 'fetch').length;`);
  const fetches0 = await anchorFetches();
  const url0 = await cdp.evalAsync(`return location.pathname + location.hash;`);
  await cdp.evalAsync(`document.querySelector('a[href="#three"]').click(); return true;`);
  await sleep(300);
  const threeTop = await cdp.evalAsync(targetTop("#three"));
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(500);
  const hashBack = await cdp.evalAsync(`
    return { url: location.pathname + location.hash, y: scrollY, keep: document.querySelector('main')?.dataset.keep ?? null,
             count: document.querySelector('main strong')?.textContent };`);
  check(`back from a same-page #hash entry keeps the page and its scroll (${JSON.stringify({ threeTop, ...hashBack })})`,
    Math.abs(threeTop) <= 1 && hashBack.url === url0 && hashBack.keep === "1" && hashBack.count === "1" && hashBack.y === 500);
  await cdp.evalAsync(`history.forward(); return true;`);
  await sleep(500);
  const hashFwd = await cdp.evalAsync(`return { url: location.pathname + location.hash, keep: document.querySelector('main')?.dataset.keep ?? null };`);
  const threeTop2 = await cdp.evalAsync(targetTop("#three"));
  check(`forward to the #hash entry scrolls to #three, same document (${JSON.stringify({ ...hashFwd, threeTop2 })})`,
    hashFwd.url === "/anchors#three" && hashFwd.keep === "1" && Math.abs(threeTop2) <= 1);
  check("hash-only history moves don't fetch the page", (await anchorFetches()) === fetches0);

  // Fragments on client navigation: /anchors#two lands on #two (an <a name> counts too, and a
  // fragment with no target lands at the top).
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(500);
  await cdp.evalAsync(`window.__nav('/anchors#two'); return true;`);
  await sleep(800);
  const two = await cdp.evalAsync(`return { url: location.pathname + location.hash, y: scrollY };`);
  const twoTop = await cdp.evalAsync(targetTop("#two"));
  check(`client navigation to /anchors#two scrolls to #two (${JSON.stringify({ ...two, twoTop })})`,
    two.url === "/anchors#two" && two.y > 0 && Math.abs(twoTop) <= 1);
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(500);
  await cdp.evalAsync(`window.__nav('/anchors#named'); return true;`);
  await sleep(800);
  const namedTop = await cdp.evalAsync(targetTop('a[name="named"]'));
  check(`client navigation to /anchors#named scrolls to <a name="named"> (${namedTop})`, Math.abs(namedTop) <= 1);
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(500);
  await cdp.evalAsync(`window.__nav('/anchors#missing'); return true;`);
  await sleep(800);
  check("client navigation to a missing fragment lands at the top", (await cdp.evalAsync(`return scrollY;`)) === 0);

  // Responses that aren't a page are left to the browser (a full navigation): a download, JSON,
  // and a redirect to another origin.
  await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(500);
  cdp.events.length = 0;
  await cdp.evalAsync(`window.__nav('/api/export'); return true;`);
  await sleep(1000);
  const dl = await cdp.evalAsync(`return { path: location.pathname, h1: document.querySelector('h1')?.textContent ?? '' };`);
  const dlNav = cdp.events.some((e) => e.method === "Network.requestWillBeSent" && e.params.type === "Document" &&
    e.params.request.url.endsWith("/api/export"));
  check(`an attachment response is a browser download, not swapped in (${JSON.stringify({ ...dl, dlNav })})`,
    dl.path === "/about" && /About/.test(dl.h1) && dlNav);
  // A slow one: the loading boundary that showed meanwhile gives the page back.
  await cdp.evalAsync(`window.__nav('/api/export?ms=500'); return true;`);
  await sleep(300);
  const dlLoading = await cdp.evalAsync(`return !!document.querySelector('[data-testid="loading"]');`);
  await sleep(1200);
  const dlSlow = await cdp.evalAsync(`return { path: location.pathname, h1: document.querySelector('h1')?.textContent ?? '',
    loading: !!document.querySelector('[data-testid="loading"]') };`);
  check(`a slow download puts back the page the loading boundary replaced (${JSON.stringify({ dlLoading, ...dlSlow })})`,
    dlLoading && dlSlow.path === "/about" && /About/.test(dlSlow.h1) && !dlSlow.loading);
  await cdp.evalAsync(`window.__nav('/api/hello'); return true;`);
  await sleep(1000);
  const json = await cdp.evalAsync(`return { path: location.pathname, type: document.contentType };`);
  check(`a JSON response is a full navigation (${JSON.stringify(json)})`, json.path === "/api/hello" && json.type === "application/json");
  await cdp.load(BASE + "/");
  await cdp.evalAsync(`
    window.__nav = (href) => { const a=document.createElement('a'); a.href=href; a.textContent=href; document.body.appendChild(a); a.click(); };
    return true;`);
  await cdp.evalAsync(`window.__nav('/api/away'); return true;`);
  await cdp.waitFor(`location.origin !== ${JSON.stringify(new URL(BASE).origin)} && document.readyState === "complete" && document.querySelector('h1')`);
  const away = await cdp.evalAsync(`
    return { origin: location.origin, path: location.pathname, h1: document.querySelector('h1')?.textContent ?? '',
             error: !!document.querySelector('[data-testid="error"], [data-nowaki-reset]') };`);
  check(`a cross-origin redirect is a full navigation (${JSON.stringify(away)})`,
    away.origin !== new URL(BASE).origin && away.path === "/about" && /About/.test(away.h1) && !away.error);

  // View Transitions (opt-in). A spy around document.startViewTransition records each transition
  // (its types are read after the router added them), and nowaki:page-load records what the page
  // showed then: it must come after the swap. CSP violations are counted throughout.
  await cdp.load(BASE + "/vt");
  const SPY = `
    window.__nav = (href, attrs = {}) => { const a=document.createElement('a'); a.href=href; a.textContent=href;
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v); document.body.appendChild(a); a.click(); };
    window.__vt = []; window.__loads = [];
    window.__cspViolations = []; addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));
    const orig = Document.prototype.startViewTransition;
    document.startViewTransition = function (arg) { const t = orig.call(this, arg); window.__vt.push(t); return t; };
    document.addEventListener('nowaki:page-load', () => window.__loads.push({ path: location.pathname, h1: document.querySelector('h1')?.id ?? null }));
    return true;`;
  await cdp.evalAsync(SPY);
  const vtState = () =>
    cdp.evalAsync(`return { path: location.pathname, h1: document.querySelector('h1')?.id ?? null, n: window.__vt.length,
      types: window.__vt.map((t) => (t.types ? [...t.types].join() : '?')), loads: window.__loads.slice() };`);
  const hasApi = await cdp.evalAsync(`return typeof Document.prototype.startViewTransition === 'function';`);
  check("this Chrome has document.startViewTransition", hasApi);
  const head = await cdp.evalAsync(`const s = [...document.head.querySelectorAll('style')].find((s) => s.textContent.includes('@view-transition'));
    return { meta: !!document.querySelector('meta[name="nowaki-view-transition"]'), style: !!s, nonced: (s?.nonce ?? '') === (window.__nowakiNonce ?? '') };`);
  // Under NOWAKI_CSP the style carries the response's nonce (the page's own, then the router's re-stamp).
  check(`an opted route has the <meta> and the @view-transition style (${JSON.stringify(head)})`, head.meta && head.style && head.nonced);
  // (The client-rendered link appears once the island has hydrated.)
  await cdp.waitFor(`document.getElementById('vt-island-client')`);
  const island = await cdp.evalAsync(`return { ssr: document.getElementById('vt-island-ssr')?.hasAttribute('data-nowaki-transition'),
    client: document.getElementById('vt-island-client')?.hasAttribute('data-nowaki-transition') };`);
  check(`<Link viewTransition> in an island, server- and client-rendered (${JSON.stringify(island)})`, island.ssr === true && island.client === true);

  // List → detail on an opted route: a transition, typed forward; the shared name morphs.
  // (The first click on this document: the router loads first, so wait for the swap.)
  await cdp.evalAsync(`document.getElementById('vt-card').click(); return true;`);
  await cdp.waitFor(`location.pathname === "/vt/detail" && document.querySelector('h1')?.id === "vt-detail" && window.__loads.length >= 1`);
  await sleep(200);
  let vs = await vtState();
  const hero = await cdp.evalAsync(`return getComputedStyle(document.getElementById('vt-detail') || document.body).viewTransitionName;`);
  check(`list → detail runs a View Transition typed "forward" (${JSON.stringify(vs)})`, vs.path === "/vt/detail" && vs.h1 === "vt-detail" && vs.n === 1 && vs.types[0] === "forward");
  check(`nowaki:page-load fires after the swap (${JSON.stringify(vs.loads)})`, vs.loads.length === 1 && vs.loads[0].h1 === "vt-detail");
  check(`transitionName() names the detail's heading (${hero})`, hero === "vt-hero");
  check("the swapped-in @view-transition style has this document's nonce", await cdp.evalAsync(`
    const s = [...document.head.querySelectorAll('style')].find((s) => s.textContent.includes('@view-transition'));
    return !!s && s.nonce === (window.__nowakiNonce ?? '');`));
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`back runs one typed "back" (${JSON.stringify(vs)})`, vs.path === "/vt" && vs.h1 === "vt-list" && vs.n === 2 && vs.types[1] === "back");
  await cdp.evalAsync(`history.forward(); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`forward runs one typed "forward" (${JSON.stringify(vs)})`, vs.path === "/vt/detail" && vs.n === 3 && vs.types[2] === "forward");
  // Leaving an opted page (to one that isn't) transitions; between two pages that aren't, nothing does.
  await cdp.evalAsync(`window.__nav('/about'); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`leaving an opted page transitions, and drops its <meta> (${JSON.stringify(vs)})`,
    vs.path === "/about" && vs.n === 4 && !(await cdp.evalAsync(`return !!document.querySelector('meta[name="nowaki-view-transition"]');`)));
  await cdp.evalAsync(`window.__nav('/'); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`no transition between pages that don't opt in (${JSON.stringify(vs)})`, vs.path === "/" && vs.n === 4 && vs.loads.length === 5);
  // A link opts in with data-nowaki-transition, on itself or an ancestor.
  await cdp.evalAsync(`window.__nav('/about', { 'data-nowaki-transition': '' }); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`a link with data-nowaki-transition transitions (${JSON.stringify(vs)})`, vs.path === "/about" && vs.n === 5);
  await cdp.evalAsync(`const d = document.createElement('div'); d.setAttribute('data-nowaki-transition', ''); document.body.append(d);
    const a = document.createElement('a'); a.href = ${JSON.stringify(P)} + '/'; a.textContent = 'home'; d.append(a); a.click(); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`a link inside a data-nowaki-transition element transitions (${JSON.stringify(vs)})`, vs.path === "/" && vs.n === 6);

  // prefers-reduced-motion: reduce, and a browser without the API: the same swap, no transition.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await cdp.evalAsync(`window.__nav('/vt/detail', { 'data-nowaki-transition': '' }); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`reduced motion: swapped without a transition (${JSON.stringify(vs)})`, vs.path === "/vt/detail" && vs.h1 === "vt-detail" && vs.n === 6 && vs.loads.at(-1).h1 === "vt-detail");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await cdp.evalAsync(`window.__saved = document.startViewTransition; document.startViewTransition = undefined; window.__nav('/about', { 'data-nowaki-transition': '' }); return true;`);
  await sleep(900);
  vs = await vtState();
  check(`no startViewTransition: swapped without one (${JSON.stringify(vs)})`, vs.path === "/about" && vs.n === 6 && vs.loads.at(-1).h1 !== "vt-detail");
  await cdp.evalAsync(`document.startViewTransition = window.__saved; return true;`);

  // Racing navigations: a transition whose update runs after a newer navigation started does
  // nothing (no swap, no history entry); the newer one wins.
  await cdp.evalAsync(`window.__nav('/vt'); return true;`);
  await sleep(900);
  // (/vt/detail is in the Router Cache, so the first navigation reaches its transition at once.)
  const { n: n0, loads: l0 } = await vtState();
  await cdp.evalAsync(`document.getElementById('vt-card').click(); window.__nav('/about'); return true;`);
  await sleep(1200);
  vs = await vtState();
  check(`a superseded transition doesn't swap (${JSON.stringify(vs)})`, vs.path === "/about" && vs.h1 !== "vt-detail" && vs.n === n0 + 2 && vs.loads.length === l0.length + 1 && vs.loads.at(-1).path === "/about");
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(900);
  check("nor push: back from there returns to the list", (await vtState()).path === "/vt");

  // An intercepting slot (photos/@modal): the opted link opens the modal in a transition, and the
  // page under it stays.
  await cdp.evalAsync(`window.__nav('/photos'); return true;`);
  await sleep(900);
  const nSlot = (await vtState()).n;
  await cdp.evalAsync(`window.__nav('/photos/1', { 'data-nowaki-transition': '' }); return true;`);
  await sleep(900);
  vs = await vtState();
  const modal = await cdp.evalAsync(`return { modal: !!document.getElementById('photo-intercepted'), list: !!document.getElementById('photos') };`);
  check(`a slot modal opens in a transition (${JSON.stringify({ ...vs, ...modal })})`, vs.path === "/photos/1" && modal.modal && modal.list && vs.n === nSlot + 1);
  await cdp.evalAsync(`history.back(); return true;`);
  await sleep(700);
  const closed = await cdp.evalAsync(`return { path: location.pathname, modal: !!document.getElementById('photo-intercepted'), list: !!document.getElementById('photos') };`);
  check(`back closes the modal (${JSON.stringify(closed)})`, closed.path === "/photos" && !closed.modal && closed.list);
  // (Under NOWAKI_CSP every <style> on screen must carry this document's nonce, and no fetched page
  // reported a violation while DOMParser parsed it.)
  check("every <style> on screen has this document's nonce", await cdp.evalAsync(`return [...document.querySelectorAll('style')].every((s) => s.nonce === (window.__nowakiNonce ?? ''));`));
  const vtViolations = await cdp.evalAsync(`return window.__cspViolations;`);
  check(`no CSP violations through the View Transition navigations (${vtViolations.join(", ")})`, vtViolations.length === 0);

  // Raw HTML (routes/raw-html.tsx): its inline <script> / <style> get no nonce, so under
  // NOWAKI_CSP they stay blocked, on a full load and after a client navigation, while nonce() and
  // Nowaki's own tags keep working. The injected <nowaki-island src> and #nowaki-runtime tag never
  // make islands.js import anything from evil.invalid (with or without a CSP).
  const rawState = () => cdp.evalAsync(`
    const color = (id) => getComputedStyle(document.getElementById(id)).color;
    return { csp: !!window.__nowakiNonce, ran: window.__rawRan ?? null, raw: color('raw-probe'), helper: color('helper-probe'),
      fake: document.getElementById('raw-fake')?.nonce === window.__nowakiNonce, same: window.__sameDoc === 1,
      hydrated: !!document.querySelector('nowaki-island[name="Counter"]')?.__nowakiHydrated };`);
  const evilRequests = () => cdp.events.filter((e) => e.method === "Network.requestWillBeSent" && /evil\.invalid/.test(e.params?.request?.url ?? "")).length;
  await cdp.load(BASE + "/raw-html");
  await cdp.waitFor(`document.querySelector('nowaki-island[name="Counter"]')?.__nowakiHydrated`);
  let raw = await rawState();
  check(`raw HTML, full load: the page hydrates and nonce() styles apply (${JSON.stringify(raw)})`, raw.hydrated && raw.helper === "rgb(0, 128, 0)");
  if (raw.csp) {
    check(`raw HTML, full load: its inline script and style are blocked (${JSON.stringify(raw)})`, raw.ran === null && raw.raw !== "rgb(255, 0, 0)" && !raw.fake);
  }
  await cdp.load(BASE + "/");
  await cdp.evalAsync(`
    window.__nav = (href) => { const a=document.createElement('a'); a.href=href; a.textContent=href; document.body.appendChild(a); a.click(); };
    window.__sameDoc = 1; window.__nav('/raw-html'); return true;`);
  await cdp.waitFor(`document.getElementById('raw-title') && document.querySelector('nowaki-island[name="Counter"]')?.__nowakiHydrated`);
  raw = await rawState();
  check(`raw HTML, client navigation: swapped in, hydrated, nonce() styles apply (${JSON.stringify(raw)})`, raw.same && raw.hydrated && raw.helper === "rgb(0, 128, 0)");
  if (raw.csp) {
    check(`raw HTML, client navigation: its style is blocked and no tag gains the nonce (${JSON.stringify(raw)})`, raw.ran === null && raw.raw !== "rgb(255, 0, 0)" && !raw.fake);
  }
  await sleep(300);
  check(`no injected island or router is fetched (${evilRequests()} requests to evil.invalid)`, evilRequests() === 0);

  // Under a basePath, a same-origin link outside it belongs to another app: a full load.
  if (P) {
    await cdp.load(BASE + "/");
    await cdp.evalAsync(`
      window.__nav = (href) => { const a=document.createElement('a'); a.href=href; a.textContent=href; document.body.appendChild(a); a.click(); };
      return true;`);
    await cdp.evalAsync(`window.__nav('/about'); return true;`);
    await cdp.waitFor(`location.pathname === "/about" && window.__nowakiRouter`);
    await cdp.evalAsync(`window.__marker = 1; window.__nav(location.origin + '/outside-base'); return true;`);
    await sleep(1000);
    const outside = await cdp.evalAsync(`return { path: location.pathname, marker: window.__marker ?? null };`);
    check(`a link outside basePath is a full load (${JSON.stringify(outside)})`, outside.path === "/outside-base" && outside.marker === null);
  }

  console.log(`\n${failures === 0 ? "BROWSER ROUTER TEST PASSED" : `BROWSER ROUTER TEST FAILED (${failures})`}`);
} catch (err) {
  console.error("harness error:", err);
  failures++;
} finally {
  // Wait for Chrome to exit before removing its profile (it writes to it while shutting down).
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const gone = new Promise((r) => chrome.once("exit", r));
    chrome.kill("SIGKILL");
    await Promise.race([gone, sleep(5000)]);
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
