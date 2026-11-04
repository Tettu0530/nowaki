// Opens a page in headless Chromium (cache disabled), waits until the network has been quiet for
// 2 s, and reports what was transferred, every response body gzipped at zlib's default level:
//   js      JavaScript files the browser fetched + inline scripts it executes (JSON and import maps
//           are data, not code, and are left out of `js`; they still count in `total`)
//   total   every response body (document, scripts, styles, fetch/xhr data, other), plus nothing
//           else: inline scripts are already inside the document
//   byType  `total` split by CDP resource type
//   idle    JS whose path matches `idleJs` (e.g. Nowaki's idle-loaded router), part of `js`
//   hydrated  elements carrying data-hydrated (each island sets it once mounted)
// Needs Chromium: CHROME=/path/to/chrome, or a Playwright-installed headless shell.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => Math.round((n / 1024) * 100) / 100;

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const dir = existsSync(cache) && readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const bin = dir && path.join(cache, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
  if (!bin || !existsSync(bin)) throw new Error("set CHROME to a Chromium binary");
  return bin;
}

export async function measure(url, { idleJs } = {}) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const userDir = path.join(os.tmpdir(), `compare-chrome-${port}-${Date.now()}`);
  const proc = spawn(chrome(), ["--headless", `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, "about:blank"], { stdio: "ignore" });
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      } catch {}
      if (!target) await sleep(100);
    }
    if (!target) throw new Error("Chromium did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const responses = new Map();
    let last = Date.now();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) pending.get(m.id)(m.result);
      if (m.method === "Network.responseReceived") {
        last = Date.now();
        const r = m.params.response;
        responses.set(m.params.requestId, { url: r.url, type: m.params.type, mime: r.mimeType });
      }
      if (m.method === "Network.loadingFinished") last = Date.now();
    };
    const send = (method, params = {}) =>
      new Promise((r) => {
        const i = ++id;
        pending.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await send("Network.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Page.enable");
    await send("Page.navigate", { url });
    await sleep(1000);
    while (Date.now() - last < 2000) await sleep(200);

    const byType = {};
    const files = [];
    let total = 0;
    let js = 0;
    let idle = 0;
    for (const [rid, r] of responses) {
      const body = await send("Network.getResponseBody", { requestId: rid });
      if (!body) continue;
      const gz = gzipSync(Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8")).length;
      const type = (r.type ?? "Other").toLowerCase();
      byType[type] = (byType[type] ?? 0) + gz;
      total += gz;
      if (type === "script" || /javascript/.test(r.mime)) {
        const file = new URL(r.url).pathname;
        const lazy = Boolean(idleJs?.test(file));
        js += gz;
        if (lazy) idle += gz;
        files.push({ path: file, gzKB: kb(gz), ...(lazy ? { idle: true } : {}) });
      }
    }
    const page = (
      await send("Runtime.evaluate", {
        expression: `({
          inline: [...document.querySelectorAll('script:not([src])')]
            .filter(s => ['', 'module', 'text/javascript', 'application/javascript'].includes((s.type || '').toLowerCase()))
            .map(s => s.textContent),
          hydrated: document.querySelectorAll('[data-hydrated]').length,
          islands: document.querySelectorAll('[data-island]').length,
          marker: document.querySelector('[data-bench]')?.textContent ?? null,
        })`,
        returnByValue: true,
      })
    ).result.value;
    const inline = page.inline.length ? gzipSync(Buffer.from(page.inline.join("\n"))).length : 0;
    ws.close();
    return {
      jsKB: kb(js + inline),
      jsFileKB: kb(js),
      inlineKB: kb(inline),
      inlineScripts: page.inline.length,
      idleKB: kb(idle),
      totalKB: kb(total),
      byTypeKB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, kb(v)])),
      requests: responses.size,
      jsFiles: files.length,
      files,
      islands: page.islands,
      hydrated: page.hydrated,
      marker: page.marker,
    };
  } finally {
    proc.kill("SIGKILL");
  }
}
