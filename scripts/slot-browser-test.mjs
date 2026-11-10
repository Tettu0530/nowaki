// Intercepting routes + the client router's slot mode in a real browser (Chrome over CDP): a
// gallery whose root @modal slot intercepts /photo/[id]. Clicking a photo opens the modal (URL
// /photo/1, the gallery and its island state kept), back closes it, forward reopens it as it was,
// a reload renders the full page, and back / forward from there close and reopen it again. Also
// checks the fragment request, the modal's CSS and island, CSP violations, and that the
// `nowaki start` ISR cache never answers or stores a fragment request.
//   node scripts/slot-browser-test.mjs <start|dev|csp|combo>... [--port 5041]
// Modes: start (`nowaki start`), dev (`nowaki dev`), csp (`nowaki start` with
// NOWAKI_CSP=enforce), combo (`nowaki start` with i18n-e2e.mjs's combo config: basePath "/app",
// trailingSlash "never", i18n en/ja; browsed in ja, with no @modal/default.tsx). Each mode uses
// its own port from --port up. Chrome is driven over --remote-debugging-pipe (no port); CHROME and
// NOWAKI_BIN (default target/debug/nowaki) override the defaults.

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 5041;
const modes = args.filter((a, i) => !a.startsWith("--") && (portArg < 0 || i !== portArg + 1));
const KNOWN = ["start", "dev", "csp", "combo"];
if (!modes.length || modes.some((m) => !KNOWN.includes(m))) {
  console.error(`usage: node scripts/slot-browser-test.mjs <${KNOWN.join("|")}>... [--port 5041]`);
  process.exit(2);
}
const BIN = process.env.NOWAKI_BIN ?? path.join(ROOT, "target/debug/nowaki" + (process.platform === "win32" ? ".exe" : ""));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : `  (${detail})`}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function files(mode) {
  const combo = mode === "combo";
  const out = {
    "package.json": `{ "name": "slot-browser-test", "private": true, "type": "module" }\n`,
    "nowaki.config.mjs": combo
      ? `export default { site: "https://example.com", basePath: "/app", trailingSlash: "never", i18n: { locales: ["en", "ja"], defaultLocale: "en" } };\n`
      : "export default {};\n",
    "islands/Counter.tsx": `import { useState } from "preact/hooks";
export default function Counter({ id }: { id: string }) {
  const [n, setN] = useState(0);
  return <button id={id} onClick={() => setN(n + 1)}>{\`\${id}:\${n}\`}</button>;
}
`,
    // The exit-criterion layout: the page, then whatever the modal slot shows.
    "routes/_layout.tsx": `import type { LayoutProps } from "@nowaki-dev/runtime";
export default function Root({ children, slots }: LayoutProps) {
  return <>{children}{slots.modal}</>;
}
`,
    "routes/index.tsx": `import { Link, localePath } from "@nowaki-dev/runtime/navigation";
import Counter from "../islands/Counter.tsx";
export default function Gallery() {
  return (
    <main>
      <h1 id="gallery">Gallery</h1>
      <Counter id="g" />
      <Link id="p1" href={localePath("/photo/1")}>photo 1</Link>
    </main>
  );
}
`,
    "routes/photo/[id].tsx": `export const revalidate = 60;
export default function Photo({ params }: { params: { id: string } }) {
  return <main><h1 id="photo-page">{\`PHOTO PAGE \${params.id}\`}</h1></main>;
}
`,
    "routes/@modal/(.)photo/modal.css": ".modal { border: 3px solid rgb(255, 0, 0); }\n",
    "routes/@modal/(.)photo/[id].tsx": `import "./modal.css";
import Counter from "../../../islands/Counter.tsx";
export function loader(ctx: { params: { id: string } }) {
  return { caption: \`caption \${ctx.params.id}\` };
}
export default function Modal({ data, params }: { data: { caption: string }; params: { id: string } }) {
  return (
    <dialog open id="modal" class="modal">
      {\`MODAL \${params.id} \${data.caption}\`}
      <Counter id="m" />
    </dialog>
  );
}
`,
  };
  // A default that renders nothing; the combo app has none (the slot is null either way).
  if (!combo) out["routes/@modal/default.tsx"] = "export default function NoModal() {\n  return null;\n}\n";
  return out;
}

// Under the worktree, so `nowaki dev` may serve the linked packages from /@fs/.
const tmpBase = path.join(ROOT, "target");
mkdirSync(tmpBase, { recursive: true });
const tmp = mkdtempSync(path.join(tmpBase, "slot-browser-"));
const children = new Set();
let chrome;
const cleanup = () => {
  for (const c of children) c.kill("SIGKILL");
  chrome?.kill("SIGKILL");
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

function makeApp(name, mode) {
  const dir = path.join(tmp, name);
  for (const [file, text] of Object.entries(files(mode))) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  linkModules(path.join(ROOT, "examples/hello/node_modules"), path.join(dir, "node_modules"));
  return dir;
}

// Each package is linked to its real directory by an absolute junction (see rules-e2e.mjs: a
// whole-node_modules junction breaks pnpm's relative links under `nowaki dev` on Windows).
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

function build(dir) {
  const r = spawnSync(BIN, ["build", dir], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("nowaki build failed");
  }
}

async function serve(argv, env, port) {
  const child = spawn(BIN, argv, { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, ...env } });
  children.add(child);
  for (let i = 0; i < 160; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/__nowaki/boundaries" }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return () => (child.kill(), children.delete(child));
    await sleep(250);
  }
  throw new Error(`nowaki ${argv.join(" ")} did not listen on ${port}`);
}

const get = (port, p, headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
    req.end();
  });

// CDP over Chrome's --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-separated JSON), attached to
// one page with a flat session. No debugging port: nothing else can drive the browser.
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
    const box = await this.eval(`const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    if (!box) throw new Error(`no ${selector} to click`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await sleep(30);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  async load(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete"`);
    await this.watch();
  }
  async reload() {
    await this.send("Page.reload", {});
    await sleep(300);
    await this.waitFor(`document.readyState === "complete"`);
    await this.watch();
  }
  // CSP violations of this document, for the csp mode.
  watch() {
    return this.eval(`window.__violations = []; document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(e.violatedDirective + " " + e.blockedURI)); return true;`);
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
  return cdp;
}

// The browser flow. `prefix` is what the browser sees in front of the route paths ("/app/ja").
async function browse(cdp, t, origin, prefix, csp) {
  const at = (p) => `location.pathname.replace(/\\/$/, "") === ${JSON.stringify((prefix + p).replace(/\/$/, ""))}`;
  await cdp.load(origin + (prefix || "/"));
  check(t("the gallery renders with an empty modal mount point"), await cdp.waitFor(`document.querySelector("#gallery") && document.querySelector("nowaki-slot[data-nowaki-slot]")?.childNodes.length === 0`));
  await cdp.waitFor(`document.querySelector("#g")`);
  await cdp.click("#g");
  check(t("the gallery's island is live"), await cdp.waitFor(`document.querySelector("#g")?.textContent === "g:1"`));

  const before = cdp.events.length;
  await cdp.click("#p1");
  const opened = await cdp.waitFor(`document.querySelector("#modal")`);
  check(t("clicking a photo opens the modal"), opened);
  check(t("the URL becomes /photo/1"), await cdp.waitFor(at("/photo/1")), await cdp.eval(`return location.pathname`));
  const state = await cdp.eval(`return {
    gallery: !!document.querySelector("#gallery"),
    page: !!document.querySelector("#photo-page"),
    g: document.querySelector("#g")?.textContent,
    text: document.querySelector("#modal")?.textContent,
    border: document.querySelector("#modal") && getComputedStyle(document.querySelector("#modal")).borderTopColor,
    inSlot: !!document.querySelector("nowaki-slot[data-nowaki-slot] #modal"),
  };`);
  check(t("the gallery and its island state stay"), state.gallery && !state.page && state.g === "g:1", JSON.stringify(state));
  check(t("the modal shows the intercepting file with its loader data"), state.inSlot && /MODAL 1 caption 1/.test(state.text ?? ""), JSON.stringify(state));
  check(t("the modal's CSS applies"), state.border === "rgb(255, 0, 0)", state.border);
  const sent = cdp.events.slice(before).filter((e) => e.method === "Network.requestWillBeSent" && new URL(e.params.request.url).pathname === `${prefix}/photo/1`);
  check(t("the router asked for the fragment with x-nowaki-intercept"), sent.length > 0 && sent.every((e) => e.params.request.headers["x-nowaki-intercept"] === "/@modal"), JSON.stringify(sent.map((e) => e.params.request.headers)));
  await cdp.click("#m");
  check(t("the modal's island hydrates"), await cdp.waitFor(`document.querySelector("#m")?.textContent === "m:1"`));

  await cdp.eval(`history.back(); return true;`);
  check(t("back closes the modal"), await cdp.waitFor(`!document.querySelector("#modal") && ${at("/")}`), await cdp.eval(`return location.pathname`));
  check(t("back keeps the gallery's island state"), (await cdp.eval(`return document.querySelector("#g")?.textContent`)) === "g:1");

  const fetchesBefore = cdp.requests(`${prefix}/photo/1`).length;
  await cdp.eval(`history.forward(); return true;`);
  check(t("forward reopens the modal"), await cdp.waitFor(`document.querySelector("#modal") && ${at("/photo/1")}`));
  check(t("forward puts the modal back as it was (its island state too), without a fetch"), (await cdp.eval(`return document.querySelector("#m")?.textContent`)) === "m:1" && cdp.requests(`${prefix}/photo/1`).length === fetchesBefore);

  await cdp.eval(`history.back(); return true;`);
  await cdp.waitFor(`!document.querySelector("#modal")`);
  const n = cdp.requests(`${prefix}/photo/1`).length;
  await cdp.click("#p1");
  check(t("opening it again comes from the Router Cache"), (await cdp.waitFor(`document.querySelector("#modal")`)) && cdp.requests(`${prefix}/photo/1`).length === n);
  if (csp) check(t("no CSP violations"), (await cdp.eval(`return window.__violations.length`)) === 0, JSON.stringify(await cdp.eval(`return window.__violations`)));

  await cdp.reload();
  const full = await cdp.waitFor(`document.querySelector("#photo-page")`);
  check(t("a reload shows the full page"), full && !(await cdp.eval(`return !!document.querySelector("#gallery") || !!document.querySelector("#modal")`)));
  // Reloaded on an entry the router made, the page loads the router at once (islands.js).
  check(t("the reloaded page loads the router for back / forward"), await cdp.waitFor(`window.__nowakiRouter`));
  await cdp.eval(`history.back(); return true;`);
  check(t("back from the reloaded page closes the modal (the gallery)"), await cdp.waitFor(`document.querySelector("#gallery") && !document.querySelector("#modal") && ${at("/")}`), await cdp.eval(`return location.pathname + " " + document.body.innerHTML.slice(0, 200)`));
  await cdp.eval(`history.forward(); return true;`);
  check(t("forward reopens the modal over the gallery"), await cdp.waitFor(`document.querySelector("#modal") && document.querySelector("#gallery") && ${at("/photo/1")}`), await cdp.eval(`return location.pathname + " " + document.body.innerHTML.slice(0, 300)`));
  if (csp) check(t("no CSP violations after the reload"), (await cdp.eval(`return window.__violations.length`)) === 0, JSON.stringify(await cdp.eval(`return window.__violations`)));
}

// The `nowaki start` ISR cache: /photo/1 is an ISR page, its fragment request must not get the
// cached page, and the fragment must not be cached.
async function isrChecks(t, port, prefix) {
  const p = `${prefix}/photo/1`;
  await get(port, p);
  const hit = await get(port, p);
  check(t("ISR: the full page is cached"), hit.headers["x-nowaki-cache"] === "HIT" && hit.body.includes("PHOTO PAGE 1"), `${hit.status} ${hit.headers["x-nowaki-cache"]}`);
  check(t("ISR: the full page varies on x-nowaki-intercept"), /x-nowaki-intercept/i.test(hit.headers.vary ?? ""), hit.headers.vary);
  for (let i = 0; i < 2; i++) {
    const frag = await get(port, p, { "x-nowaki-intercept": "/@modal" });
    check(
      t(`ISR: a fragment request never gets the cached page (#${i + 1})`),
      frag.status === 200 && frag.body.startsWith("<template data-nowaki-head>") && !frag.body.includes("PHOTO PAGE") && frag.headers["x-nowaki-cache"] === undefined && frag.headers["cache-control"] === "private, no-store",
      `${frag.status} ${frag.headers["x-nowaki-cache"]} ${frag.body.slice(0, 120)}`,
    );
  }
  const after = await get(port, p);
  check(t("ISR: the fragment was never stored"), after.headers["x-nowaki-cache"] === "HIT" && after.body.includes("PHOTO PAGE 1") && !after.body.startsWith("<template"), after.body.slice(0, 120));
}

try {
  const cdp = await startChrome();
  for (const [i, mode] of modes.entries()) {
    console.log(`\n--- ${mode} ---`);
    const t = (s) => `${mode}: ${s}`;
    const port = PORT + i;
    const dir = makeApp(mode, mode);
    const prefix = mode === "combo" ? "/app/ja" : "";
    let stop;
    if (mode === "dev") {
      stop = await serve(["dev", dir, "--port", String(port)], {}, port);
    } else {
      build(dir);
      stop = await serve(["start", dir, "--port", String(port)], mode === "csp" ? { NOWAKI_CSP: "enforce" } : {}, port);
    }
    try {
      if (mode !== "dev") await isrChecks(t, port, prefix);
      await browse(cdp, t, `http://127.0.0.1:${port}`, prefix, mode === "csp");
    } finally {
      stop();
    }
  }
} catch (e) {
  console.error(e);
  failed++;
}

console.log(failed ? `\nSLOT BROWSER TEST FAILED (${failed})` : "\nSLOT BROWSER TEST PASSED");
process.exit(failed ? 1 : 0);
