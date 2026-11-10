// examples/gallery in a real browser (Chrome over CDP), on `nowaki start` under /gallery: a
// Japanese browser landing on /gallery is sent to /gallery/ja; a click on a photo opens the modal
// (URL /gallery/ja/photo/1, the gallery kept); its close button (history.back) closes it; a
// reload of a photo URL is the full page and back from there is the gallery; the language
// switcher sets the nowaki_locale cookie, which then wins over Accept-Language; and the sign-in
// form leads to the account page and sign-out back out. Builds the example in place.
//   node scripts/gallery-browser-test.mjs [--port 5140]
// Chrome is driven over --remote-debugging-pipe (no port); CHROME and NOWAKI_BIN (default
// target/debug/nowaki) override the defaults.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
let server;
let chrome;
process.on("exit", () => {
  server?.kill("SIGKILL");
  chrome?.kill("SIGKILL");
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
});
process.on("SIGINT", () => process.exit(130));

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
    const box = await this.eval(`const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
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

try {
  await start();
  const cdp = await startChrome();

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
} catch (e) {
  console.error(e);
  failed++;
}

console.log(failed ? `\nGALLERY BROWSER TEST FAILED (${failed})` : "\nGALLERY BROWSER TEST PASSED");
process.exit(failed ? 1 : 0);
