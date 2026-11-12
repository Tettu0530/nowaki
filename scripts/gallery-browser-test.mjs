// examples/gallery in a real browser (Chrome over CDP), on `nowaki start` under /gallery: a
// Japanese browser landing on /gallery is sent to /gallery/ja; a click on a photo opens the modal
// (URL /gallery/ja/photo/1, the gallery kept); its close button (history.back) closes it; a
// reload of a photo URL is the full page and back from there is the gallery; the language
// switcher sets the nowaki_locale cookie, which then wins over Accept-Language; and the sign-in
// form leads to the account page and sign-out back out. Then the v0.19 criteria: a click from the
// post list to a post runs a View Transition (a spy on document.startViewTransition, typed
// "forward", the thumbnail and the photo sharing a view-transition-name), and without one under
// prefers-reduced-motion or without the API, the same navigation. Builds the example in place.
// The `dev` half runs `nowaki dev` on a copy of the example (port + 1): an edit to an island
// keeps its state (Fast Refresh, under the basePath), and the dev toolbar lists the page's islands
// and its first-load JS against the route's `budget`.
//   node scripts/gallery-browser-test.mjs [start] [dev] [--port 5140]   (both by default)
// Chrome is driven over --remote-debugging-pipe (no port); CHROME and NOWAKI_BIN (default
// target/debug/nowaki) override the defaults.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "examples/gallery");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 5140;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEV_ORIGIN = `http://127.0.0.1:${PORT + 1}`;
const modes = args.filter((a, i) => !a.startsWith("--") && (portArg < 0 || i !== portArg + 1));
if (modes.some((m) => m !== "start" && m !== "dev")) {
  console.error("usage: node scripts/gallery-browser-test.mjs [start] [dev] [--port 5140]");
  process.exit(2);
}
const run = (m) => !modes.length || modes.includes(m);
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "gallery-browser-password";
const ENV = { ...process.env, GALLERY_ADMIN_PASSWORD: PASSWORD, NOWAKI_SESSION_SECRET: "gallery-browser-session-secret-0123456789" };

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), "nowaki-gallery-browser-"));
// The dev half's copy of the app: inside the repository, since dev serves dependencies outside
// the app root (the pnpm store) only from the workspace around it.
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const devTmp = mkdtempSync(path.join(ROOT, "target", "gallery-dev-"));
let server;
let devServer;
let chrome;
process.on("exit", () => {
  server?.kill("SIGKILL");
  devServer?.kill("SIGKILL");
  chrome?.kill("SIGKILL");
  for (const dir of [tmp, devTmp]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {}
  }
});
process.on("SIGINT", () => process.exit(130));

async function listening(port, p) {
  for (let i = 0; i < 240; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: p }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

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

async function startDev() {
  const dir = path.join(devTmp, "app");
  const skip = new Set(["node_modules", "dist", ".nowaki"]);
  cpSync(APP, dir, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  linkModules(path.join(APP, "node_modules"), path.join(dir, "node_modules"));
  devServer = spawn(BIN, ["dev", dir, "--port", String(PORT + 1)], { stdio: ["pipe", "inherit", "inherit"], env: { ...ENV, NOWAKI_TOOLBAR: "" } });
  if (!(await listening(PORT + 1, "/gallery/posts/1"))) throw new Error(`nowaki dev did not listen on ${PORT + 1}`);
  return dir;
}

async function start() {
  const r = spawnSync(BIN, ["build", APP], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("nowaki build failed");
  }
  server = spawn(BIN, ["start", APP, "--port", String(PORT)], { stdio: ["pipe", "inherit", "inherit"], env: ENV });
  for (let i = 0; i < 160; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/gallery/__nowaki/boundaries" }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(250);
  }
  throw new Error(`nowaki start did not listen on ${PORT}`);
}

// CDP over Chrome's --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-separated JSON), attached to
// one page with a flat session (as in slot-browser-test.mjs).
class CDP {
  constructor(input, output) {
    this.input = input;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
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
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async waitFor(expr, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await this.eval(`return !!(${expr});`)) return true;
      } catch {}
      await sleep(50);
    }
    return false;
  }
  // A real mouse click (move, press, release) in the middle of the element.
  async click(selector) {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    // (Scrolled into view first: a click outside the viewport hits nothing.)
    const box = await this.eval(`const el = document.querySelector(${JSON.stringify(selector)}); el?.scrollIntoView({ block: "center", behavior: "instant" }); const r = el?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    if (!box) throw new Error(`no ${selector} to click`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await sleep(30);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  async load(url) {
    await this.send("Page.navigate", { url });
    await sleep(100);
    await this.waitFor(`document.readyState === "complete"`);
  }
  async reload() {
    await this.send("Page.reload", {});
    await sleep(300);
    await this.waitFor(`document.readyState === "complete"`);
  }
  // Requests the page made to a URL path, with their x-nowaki-intercept header.
  requests(pathname) {
    return this.events
      .filter((e) => e.method === "Network.requestWillBeSent" && new URL(e.params.request.url).pathname === pathname)
      .map((e) => e.params.request.headers["x-nowaki-intercept"] ?? e.params.request.headers["X-Nowaki-Intercept"] ?? null);
  }
}

async function startChrome() {
  chrome = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(tmp, "chrome")}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const cdp = new CDP(chrome.stdio[3], chrome.stdio[4]);
  let page;
  // Chrome can take a while to start on CI runners: wait up to 30s for the page target.
  for (let i = 0; i < 120 && !page; i++) {
    page = (await Promise.race([cdp.send("Target.getTargets"), sleep(250)]))?.targetInfos?.find((x) => x.type === "page");
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`Chrome gave no page target over CDP (CHROME=${CHROME})`);
  cdp.session = (await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  // A Japanese browser: Accept-Language ja first.
  const { userAgent } = await cdp.send("Browser.getVersion", {}, null);
  await cdp.send("Network.setUserAgentOverride", { userAgent, acceptLanguage: "ja-JP,ja;q=0.9,en;q=0.5" });
  return cdp;
}

const at = (p) => `location.pathname === ${JSON.stringify(p)}`;
const cookie = (cdp) => cdp.eval(`return document.cookie`);

const TB = `document.querySelector("nowaki-toolbar")?.shadowRoot`;
const tq = (sel) => `${TB}?.querySelector(${JSON.stringify(sel)})`;
const panelText = `(${tq(".body")}?.textContent ?? "")`;

try {
  const cdp = await startChrome();
  if (run("start")) {
    await start();

    // Detection: a Japanese browser on /gallery lands on /gallery/ja.
    await cdp.load(`${ORIGIN}/gallery`);
    check("Accept-Language ja on /gallery lands on /gallery/ja", await cdp.waitFor(`${at("/gallery/ja")} && document.documentElement.lang === "ja" && document.querySelector("#gallery")`), await cdp.eval(`return location.pathname`));
    check("the modal slot is mounted, empty", await cdp.waitFor(`document.querySelector("nowaki-slot[data-nowaki-slot]")?.childNodes.length === 0`));

    // Client navigation to a photo: the modal over the gallery.
    const before = cdp.events.length;
    await cdp.click("#photo-1");
    check("clicking a photo opens the modal", await cdp.waitFor(`document.querySelector("nowaki-slot #photo-modal")`));
    check("the URL becomes /gallery/ja/photo/1", await cdp.waitFor(at("/gallery/ja/photo/1")), await cdp.eval(`return location.pathname`));
    check("the gallery stays under the modal", await cdp.eval(`return !!document.querySelector("#gallery") && !document.querySelector("#photo-page")`));
    const sent = cdp.events.slice(before).filter((e) => e.method === "Network.requestWillBeSent" && new URL(e.params.request.url).pathname === "/gallery/ja/photo/1");
    check("the router asked for the fragment", sent.length > 0 && sent.every((e) => e.params.request.headers["x-nowaki-intercept"] === "/@modal"), JSON.stringify(sent.map((e) => e.params.request.headers)));
    check("the modal's CSS applies", await cdp.waitFor(`getComputedStyle(document.querySelector("#photo-modal")).position === "fixed"`));
    check("the modal is in Japanese", (await cdp.eval(`return document.querySelector("#photo-modal h2")?.textContent`)) === "\u7802\u4E18");

    // Its close button is an island calling history.back().
    await cdp.click("#close");
    check("the close button (back) closes the modal", await cdp.waitFor(`!document.querySelector("#photo-modal") && ${at("/gallery/ja")} && document.querySelector("#gallery")`), await cdp.eval(`return location.pathname`));
    await cdp.eval(`history.forward(); return true;`);
    check("forward reopens it", await cdp.waitFor(`document.querySelector("#photo-modal") && ${at("/gallery/ja/photo/1")}`));
    await cdp.eval(`history.back(); return true;`);
    check("browser back closes it", await cdp.waitFor(`!document.querySelector("#photo-modal") && ${at("/gallery/ja")}`));

    // A reload of a photo URL is the full page; back from it is the gallery.
    await cdp.click("#photo-2");
    await cdp.waitFor(`document.querySelector("#photo-modal") && ${at("/gallery/ja/photo/2")}`);
    await cdp.reload();
    check("a reload shows the full photo page", await cdp.waitFor(`document.querySelector("#photo-page")`) && !(await cdp.eval(`return !!document.querySelector("#gallery") || !!document.querySelector("#photo-modal")`)));
    check("the full page is in Japanese", (await cdp.eval(`return document.querySelector("#photo-page h1")?.textContent`)) === "\u6D77");
    await cdp.waitFor(`window.__nowakiRouter`);
    await cdp.eval(`history.back(); return true;`);
    check("back from the reloaded page is the gallery", await cdp.waitFor(`document.querySelector("#gallery") && !document.querySelector("#photo-modal") && ${at("/gallery/ja")}`), await cdp.eval(`return location.pathname`));

    // The language switcher: <Link locale> in an island sets nowaki_locale, which then wins.
    await cdp.load(`${ORIGIN}/gallery/ja/photo/3`);
    await cdp.waitFor(`document.querySelector("#lang-en")`);
    await sleep(300);
    await cdp.click("#lang-en");
    check("the switcher goes to the page in English", await cdp.waitFor(`${at("/gallery/photo/3")} && document.documentElement.lang === "en" && document.querySelector("#photo-page h1")?.textContent === "Dusk"`), await cdp.eval(`return location.pathname + " " + document.documentElement.lang`));
    check("the switcher set the nowaki_locale cookie", /(^|; )nowaki_locale=en(;|$)/.test(await cookie(cdp)), await cookie(cdp));
    await cdp.load(`${ORIGIN}/gallery`);
    check("the cookie wins over Accept-Language on /gallery", await cdp.waitFor(`${at("/gallery")} && document.documentElement.lang === "en" && document.querySelector("#gallery")`), await cdp.eval(`return location.pathname`));
    await sleep(300);
    await cdp.click("#lang-ja");
    check("switching back to Japanese", await cdp.waitFor(`${at("/gallery/ja")} && document.documentElement.lang === "ja"`) && /(^|; )nowaki_locale=ja(;|$)/.test(await cookie(cdp)), await cookie(cdp));

    // Sign in through the form, see the account page, sign out.
    await cdp.load(`${ORIGIN}/gallery/ja/account`);
    check("the account page sends a visitor to sign in", await cdp.waitFor(`${at("/gallery/ja/login")} && document.querySelector("#login")`), await cdp.eval(`return location.pathname`));
    await cdp.eval(`document.querySelector("#login input[name=password]").value = "wrong"; document.querySelector("#login").requestSubmit(); return true;`);
    check("a wrong password shows the error", await cdp.waitFor(`document.querySelector("#login-error")`));
    await cdp.waitFor(`document.querySelector("#login input[name=password]")`);
    await cdp.eval(`document.querySelector("#login input[name=password]").value = ${JSON.stringify(PASSWORD)}; document.querySelector("#login").requestSubmit(); return true;`);
    check("signing in shows the account page", await cdp.waitFor(`${at("/gallery/ja/account")} && document.querySelector("#signed-in strong")?.textContent === "admin"`), await cdp.eval(`return location.pathname`));
    check("the session cookie is HttpOnly (not in document.cookie)", !(await cookie(cdp)).includes("gallery_session"));
    await cdp.click("#logout");
    check("signing out goes to the gallery", await cdp.waitFor(`${at("/gallery/ja")} && document.querySelector("#gallery")`), await cdp.eval(`return location.pathname`));
    await cdp.load(`${ORIGIN}/gallery/ja/account`);
    check("signed out, the account page needs a sign-in again", await cdp.waitFor(at("/gallery/ja/login")), await cdp.eval(`return location.pathname`));

    // View Transitions from the post list to a post. A spy around document.startViewTransition
    // records each one; nowaki:page-load says when the swap is done.
    const vtSpy = `window.__vt = []; window.__loads = 0; window.__sameDoc = 1;
      const orig = Document.prototype.startViewTransition;
      document.startViewTransition = function (arg) { const t = orig.call(this, arg); window.__vt.push(t); return t; };
      document.addEventListener("nowaki:page-load", () => window.__loads++);
      return true;`;
    const vt = () => cdp.eval(`return { path: location.pathname, n: window.__vt.length, types: window.__vt.map((t) => (t.types ? [...t.types].join() : "?")), loads: window.__loads, same: window.__sameDoc === 1 };`);
    const vtName = (sel) => cdp.eval(`const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).viewTransitionName : null;`);
    await cdp.load(`${ORIGIN}/gallery/ja/posts`);
    check("the post list (in Japanese)", await cdp.waitFor(`${at("/gallery/ja/posts")} && document.querySelector("#posts") && window.__nowakiHydrateIslands`), await cdp.eval(`return location.pathname`));
    check("this Chrome has document.startViewTransition", await cdp.eval(`return typeof Document.prototype.startViewTransition === "function";`));
    await cdp.eval(vtSpy);
    check("the thumbnail carries the photo's view-transition-name", (await vtName("#post-1 img")) === "photo-1", await vtName("#post-1 img"));
    await cdp.click("#post-1");
    check("list → post is a client navigation", await cdp.waitFor(`${at("/gallery/ja/posts/1")} && document.querySelector("#post-page") && window.__loads === 1`), await cdp.eval(`return location.pathname`));
    let v = await vt();
    check(`...run as one View Transition typed "forward" (${JSON.stringify(v)})`, v.same && v.n === 1 && v.types[0] === "forward");
    check("the post's photo has the same view-transition-name", (await vtName("#post-page img")) === "photo-1", await vtName("#post-page img"));
    check("the transition finished", await cdp.eval(`return window.__vt[0].finished.then(() => true, () => false);`));
    await cdp.click("#all-posts");
    check("the post's back link transitions back to the list", await cdp.waitFor(`${at("/gallery/ja/posts")} && document.querySelector("#posts") && window.__loads === 2`) && (await vt()).n === 2, JSON.stringify(await vt()));
    // (A click while a transition still animates hits its overlay, not the page: wait it out.)
    await cdp.eval(`return window.__vt.at(-1)?.finished.then(() => true, () => true);`);

    // prefers-reduced-motion: reduce, then a browser without the API: the same navigation, no
    // transition, nothing thrown.
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await cdp.click("#post-2");
    check("reduced motion: list → post swaps without a transition", await cdp.waitFor(`${at("/gallery/ja/posts/2")} && document.querySelector("#post-page") && window.__loads === 3`) && (await vt()).n === 2, JSON.stringify(await vt()));
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.eval(`window.__errors = []; addEventListener("error", (e) => window.__errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason))); document.startViewTransition = undefined; return true;`);
    await cdp.click("#all-posts");
    check("no startViewTransition: post → list swaps without one", await cdp.waitFor(`${at("/gallery/ja/posts")} && document.querySelector("#posts") && window.__loads === 4`) && (await vt()).n === 2, JSON.stringify(await vt()));
    await cdp.click("#post-3");
    v = await vt();
    check("...and back to a post, still the same document, no errors", (await cdp.waitFor(`${at("/gallery/ja/posts/3")} && window.__loads === 5`)) && v.same && (await cdp.eval(`return window.__errors.length === 0;`)), JSON.stringify(await cdp.eval(`return window.__errors;`)));
    server.kill();
  }

  // `nowaki dev`: an island edit keeps its state, and the toolbar shows the page's islands and JS.
  if (run("dev")) {
    const dir = await startDev();
    await cdp.load(`${DEV_ORIGIN}/gallery/posts/1`);
    const likes = `document.querySelector('nowaki-island[name="Likes"]')`;
    check("dev: the post's Likes island hydrated", await cdp.waitFor(`${likes}?.__nowakiHydrated === true`, 15000));
    await cdp.eval(`window.__sameDoc = 1; return true;`);
    // Let the HMR socket open, so the edit's message isn't sent before it is.
    await sleep(800);
    for (let i = 0; i < 3; i++) await cdp.click("#likes");
    check("dev: three likes", await cdp.waitFor(`document.querySelector("#likes")?.textContent === "Like 3"`), await cdp.eval(`return document.querySelector("#likes")?.textContent`));
    const file = path.join(dir, "islands/Likes.tsx");
    const good = readFileSync(file, "utf8");
    if (!good.includes("{label} {n}")) throw new Error("islands/Likes.tsx changed: no `{label} {n}`");
    writeFileSync(file, good.replace("{label} {n}", "{label} ({n})"));
    check("dev: editing the island updates it in place and keeps the count", await cdp.waitFor(`document.querySelector("#likes")?.textContent === "Like (3)" && window.__sameDoc === 1`, 10000), await cdp.eval(`return document.querySelector("#likes")?.textContent + " same=" + (window.__sameDoc === 1)`));
    await cdp.click("#likes");
    check("dev: the edited island still counts", await cdp.waitFor(`document.querySelector("#likes")?.textContent === "Like (4)"`), await cdp.eval(`return document.querySelector("#likes")?.textContent`));

    check("dev: the toolbar mounts", await cdp.waitFor(`${tq(".pill")}`, 15000));
    await cdp.eval(`${tq(".pill")}.click(); return true;`);
    check("dev: the toolbar names the route file", await cdp.waitFor(`${tq(".title")}?.textContent.includes("routes/posts/[id].tsx")`), await cdp.eval(`return ${tq(".title")}?.textContent`));
    await cdp.eval(`${tq('[data-tab="islands"]')}?.click(); return true;`);
    check(
      "dev: the islands tab lists Likes (a hydrated client island) and the layout's LanguageSwitcher",
      await cdp.waitFor(`(() => { const li = ${tq('li[data-island="Likes"]')}; return li?.dataset.kind === "client" && li.textContent.includes("hydrated") && ${tq('li[data-island="LanguageSwitcher"]')}; })()`),
      await cdp.eval(`return ${panelText}`),
    );
    await cdp.eval(`${tq('[data-tab="js"]')}?.click(); return true;`);
    check(
      "dev: the JS tab shows the first-load estimate against the route's 12 KB budget",
      await cdp.waitFor(`/[0-9.]+ KB gzip/.test(${tq("[data-budget]")}?.textContent) && ${tq("[data-budget]")}.textContent.includes("budget 12 KB")`),
      await cdp.eval(`return ${panelText}`),
    );
    await cdp.eval(`${tq('[data-tab="isr"]')}?.click(); return true;`);
    check("dev: the ISR tab shows revalidate and the tags (a function of the params)", await cdp.waitFor(`${tq("[data-revalidate]")}?.textContent === "3600 s" && ${panelText}.includes("computed per request")`), await cdp.eval(`return ${panelText}`));
    devServer.kill();
  }
} catch (e) {
  console.error(e);
  failed++;
}

console.log(failed ? `\nGALLERY BROWSER TEST FAILED (${failed})` : "\nGALLERY BROWSER TEST PASSED");
process.exit(failed ? 1 : 0);
