// HMR client + error overlay (dev only; never part of a build). Messages from dev.rs:
//   hot    islands (and the modules between them and an edit) were re-versioned: re-import them;
//          client/refresh.js swaps the components in place, so island state survives. Live
//          (Jetstream) islands re-render on the server with the state they hold.
//   css    stylesheets changed: re-run the CSS shim of each <style data-nowaki-css>, and replace
//          each <link href="/__nowaki/css?f=…"> once the new one has loaded (no flash).
//   page   a route, a layout or a server module they import changed: refetch this URL and morph
//          the page in place. Islands whose src + props are unchanged keep their element (and
//          Preact state); live islands keep their server state. Reloads when that can't be done.
//   reload anything else (config, env, session, content, removed files).

import { h, render } from "preact";
import { matchPattern, nonceStyles } from "./router-core.js";

const OVERLAY_ID = "__nowaki_error_overlay";
const REFRESH_URL = "/node_modules/@nowaki-dev/runtime/client/refresh.js";

// This response's CSP nonce (NOWAKI_CSP), read as islands.js does: a page without islands, or the
// dev error page, doesn't load islands.js.
if (!window.__nowakiNonce) window.__nowakiNonce = document.querySelector("script[nonce]")?.nonce || undefined;

async function hot(msg) {
  const refresh = await import(REFRESH_URL);
  const touched = [];
  let live = false;
  for (const island of msg.islands || []) {
    const els = [...document.querySelectorAll("nowaki-island")].filter((el) => el.getAttribute("src") === island.src);
    if (els.length) {
      try {
        touched.push({ els, mod: await import(island.url) });
      } catch (err) {
        console.error("[nowaki] failed to reload island %s:", island.src, err);
      }
    }
    for (const el of document.querySelectorAll("nowaki-live")) {
      if (el.getAttribute("name") !== island.name) continue;
      live = true;
      await rerenderLive(el);
    }
  }
  const result = refresh.performRefresh();
  for (const { els, mod } of touched) {
    // Not a function component the runtime can swap (a class, an anonymous default export):
    // render the new one from scratch, which resets its state.
    if (!result.remount && refresh.isRefreshable(mod.default)) continue;
    for (const el of els) {
      const props = JSON.parse(el.getAttribute("props") || "{}");
      render(null, el);
      render(h(mod.default, props), el);
    }
  }
  // The socket hands the server the new state and signature (same islands, so a replacing join).
  if (live) window.__nowakiLive?.sync();
}

// A live island re-rendered by the edited module with the state it has now (no handler runs).
async function rerenderLive(el) {
  try {
    const r = await fetch(import.meta.env.BASE_URL + "__nowaki/live-event", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nowaki-live": "1" },
      body: JSON.stringify({
        name: el.getAttribute("name"),
        state: JSON.parse(el.getAttribute("state") || "{}"),
        sig: el.getAttribute("sig"),
        handler: null,
        payload: null,
      }),
    });
    const msg = r.ok ? await r.json() : null;
    if (typeof msg?.html !== "string") throw new Error(`status ${r.status}`);
    el.innerHTML = msg.html;
    el.setAttribute("state", JSON.stringify(msg.state));
    el.setAttribute("sig", msg.sig);
  } catch (err) {
    console.error("[nowaki] failed to re-render live island %s:", el.getAttribute("name"), err);
  }
}

async function css(msg) {
  const t = Date.now();
  const loads = [];
  for (const f of msg.files || []) {
    // Imported by a module: the shim sets the text of the <style> it made.
    const style = [...document.querySelectorAll("style[data-nowaki-css]")].some(
      (s) => s.getAttribute("data-nowaki-css") === f.id,
    );
    if (style) loads.push(import(`${f.url}?t=${t}`).catch((err) => console.error("[nowaki] failed to reload %s:", f.file, err)));
    // Linked by the page (route CSS).
    for (const old of document.querySelectorAll('link[rel="stylesheet"]')) {
      let url;
      try {
        url = new URL(old.href);
      } catch {
        continue;
      }
      if (!url.pathname.endsWith("/__nowaki/css") || url.searchParams.get("f") !== f.file) continue;
      url.searchParams.set("t", String(t));
      const next = old.cloneNode();
      const nonce = old.nonce || window.__nowakiNonce;
      if (nonce) next.nonce = nonce;
      next.href = url.pathname + url.search;
      loads.push(
        new Promise((resolve) => {
          const done = () => {
            old.remove();
            resolve();
          };
          next.addEventListener("load", done, { once: true });
          next.addEventListener("error", done, { once: true });
        }),
      );
      old.after(next);
    }
  }
  await Promise.all(loads);
}

// Whether the client router has swapped a page in since this document loaded. A reload of an
// entry an intercepting slot opened shows the full page, though its history.state keeps `slot`.
let navigated = false;
let ownPageLoad = false;
document.addEventListener("nowaki:page-load", () => {
  if (!ownPageLoad) navigated = true;
});

const ISLAND = "nowaki-island, nowaki-live";
const isIsland = (n) => n.nodeType === 1 && (n.localName === "nowaki-island" || n.localName === "nowaki-live");

// The page on screen, rendered again by the edited route: fetched like the router does (as the
// fragment of the open intercepting slot, when one is open), then morphed in place. Returns false
// when it reloaded instead.
async function page() {
  const slot = navigated && history.state?.slot ? openSlot() : null;
  // Not a page this can morph (the dev error page has no head region): load it again.
  if (!slot && !headRegion(document)) return reload();
  const headers = { "x-nowaki-nav": "1" };
  if (slot) headers["x-nowaki-intercept"] = slot.getAttribute("data-nowaki-slot");
  const url = location.href.split("#")[0];
  let doc;
  let timing;
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    timing = res.headers.get("server-timing") || "";
    const html = /html/.test(res.headers.get("content-type") || "") && !res.redirected && res.status === 200 ? await res.text() : null;
    if (html === null || (slot && !res.headers.has("x-nowaki-slot"))) return reload();
    // A <style> carrying another response's nonce would be a CSP violation as it parses.
    doc = new DOMParser().parseFromString(nonceStyles(html, window.__nowakiNonce), "text/html");
  } catch {
    return reload();
  }
  if (!slot && !headRegion(doc)) return reload();

  const x = window.scrollX;
  const y = window.scrollY;
  if (slot) {
    const tpl = doc.querySelector("template[data-nowaki-head]");
    tpl?.remove();
    if (tpl) addLinks(tpl.content);
    morphTree(slot, doc.body);
    if (tpl) loadPageScripts(tpl.content);
  } else {
    document.title = doc.title;
    syncHead(doc);
    syncAttrs(document.documentElement, doc.documentElement, ["lang", "dir"]);
    syncAttrs(document.body, doc.body, []);
    morphTree(document.body, doc.body);
    loadPageScripts(doc.head);
  }
  window.scrollTo(x, y);
  startRuntime(doc);
  window.__nowakiHydrateIslands?.(slot || document);
  syncLive(doc);
  ownPageLoad = true;
  try {
    const detail = slot ? { url, slot: slot.getAttribute("name"), timing } : { url, timing };
    document.dispatchEvent(new CustomEvent("nowaki:page-load", { detail }));
  } finally {
    ownPageLoad = false;
  }
  return true;
}

function reload() {
  location.reload();
  return false;
}

// The intercepting slot showing this URL (as the router's interceptFor finds it).
function openSlot() {
  for (const el of document.querySelectorAll("nowaki-slot[data-nowaki-slot]")) {
    try {
      if (JSON.parse(el.getAttribute("data-nowaki-intercepts")).some((p) => matchPattern(p, location.pathname))) return el;
    } catch {}
  }
  return null;
}

// Morphs `cur` (on screen) into `next` (parsed). Each top-level island element keeps its place in
// the order: the one at the same index is moved over when its src + props (a live island: its
// name) are the same, so its Preact tree and state survive; any other is new and hydrates. Other
// nodes are patched in place when the node type and tag match, else replaced.
function morphTree(cur, next) {
  const old = [...cur.querySelectorAll(ISLAND)].filter((el) => !el.parentElement.closest(ISLAND));
  const ctx = { old, i: 0, kept: new Set() };
  morphChildren(cur, next, ctx);
  // Islands that are gone: unmount them (effects clean up).
  for (const el of old) {
    if (ctx.kept.has(el) || el.localName !== "nowaki-island") continue;
    try {
      render(null, el);
    } catch {}
  }
}

function sameIsland(a, b) {
  if (a.localName !== b.localName) return false;
  if (a.localName === "nowaki-live") return a.getAttribute("name") === b.getAttribute("name");
  return ["src", "props", "client", "client-media"].every((n) => a.getAttribute(n) === b.getAttribute(n));
}

// The old island element for `n` (the next one in the order) when it matches, else null.
function takeIsland(n, ctx) {
  const o = ctx.old[ctx.i++];
  if (!o || !sameIsland(o, n)) return null;
  ctx.kept.add(o);
  return o;
}

// A copy of a parsed node for this document. Islands inside it take their places in the order.
function adopt(n, ctx) {
  const node = document.importNode(n, true);
  if (node.nodeType !== 1) return node;
  stampNonce(node);
  if (isIsland(node)) return takeIsland(node, ctx) || node;
  for (const el of [...node.querySelectorAll(ISLAND)]) {
    if (el.parentElement.closest(ISLAND)) continue;
    const kept = takeIsland(el, ctx);
    if (kept) el.replaceWith(kept);
  }
  return node;
}

function morphChildren(cur, next, ctx) {
  const olds = [...cur.childNodes].filter((n) => !isIsland(n));
  let oi = 0;
  let prev = null;
  for (const n of [...next.childNodes]) {
    let node;
    if (isIsland(n)) {
      node = adopt(n, ctx);
    } else {
      const o = olds[oi];
      if (o && o.nodeType === n.nodeType && o.nodeName === n.nodeName) {
        oi++;
        node = o;
        if (o.nodeType === 1) {
          syncAllAttrs(o, n);
          morphChildren(o, n, ctx);
        } else if (o.nodeValue !== n.nodeValue) {
          o.nodeValue = n.nodeValue;
        }
      } else {
        node = adopt(n, ctx);
      }
    }
    // (Recomputed each time: a kept island can have been moved out from here meanwhile.)
    const at = prev ? prev.nextSibling : cur.firstChild;
    if (node !== at) cur.insertBefore(node, at);
    prev = node;
  }
  // What the new page doesn't have.
  for (let n = prev ? prev.nextSibling : cur.firstChild; n; ) {
    const after = n.nextSibling;
    n.remove();
    n = after;
  }
}

// Every attribute of `next` on `cur` (the nonce excepted: it is this document's, hidden).
function syncAllAttrs(cur, next) {
  for (const { name } of [...cur.attributes]) {
    if (name !== "nonce" && !next.hasAttribute(name)) cur.removeAttribute(name);
  }
  for (const { name, value } of next.attributes) {
    if (name !== "nonce" && cur.getAttribute(name) !== value) cur.setAttribute(name, value);
  }
}

function stampNonce(root) {
  const nonce = window.__nowakiNonce;
  if (!nonce) return;
  if (root.localName === "style") root.nonce = nonce;
  for (const el of root.querySelectorAll("style")) el.nonce = nonce;
}

// The islands runtime, when the page had no islands before (so nothing loaded it).
function startRuntime(doc) {
  if (window.__nowakiHydrateIslands) return;
  const old = doc.getElementById("nowaki-runtime");
  if (!old?.getAttribute("src")) return;
  const el = document.createElement("script");
  el.type = "module";
  el.src = old.getAttribute("src");
  const router = old.getAttribute("data-router");
  if (router) el.setAttribute("data-router", router);
  if (window.__nowakiNonce) el.nonce = window.__nowakiNonce;
  document.getElementById("nowaki-runtime")?.removeAttribute("id");
  el.id = "nowaki-runtime";
  document.body.appendChild(el);
}

// Live islands: join the new ones (loading live.js when no page before had any).
function syncLive(doc) {
  if (window.__nowakiLive) return window.__nowakiLive.sync();
  const old = doc.getElementById("nowaki-live");
  if (!old?.getAttribute("src") || !document.querySelector("nowaki-live")) return;
  const el = document.createElement("script");
  el.type = "module";
  el.src = old.getAttribute("src");
  const transport = old.getAttribute("data-live-transport");
  if (transport !== null) el.setAttribute("data-live-transport", transport);
  if (window.__nowakiNonce) el.nonce = window.__nowakiNonce;
  document.getElementById("nowaki-live")?.removeAttribute("id");
  el.id = "nowaki-live";
  document.body.appendChild(el);
}

// The page's own <head> content sits between <meta name="nowaki-head" content="start|end">.
function headRegion(d) {
  const marks = d.head?.querySelectorAll('meta[name="nowaki-head"]');
  return marks?.length === 2 ? marks : null;
}

// What identifies a head node across renders: its markup without the nonce, and a stylesheet's
// href without the `t` a CSS update added.
function headKey(el) {
  const attrs = [...el.attributes]
    .filter((a) => a.name !== "nonce")
    .map((a) => `${a.name}=${a.name === "href" ? a.value.replace(/([?&])t=\d+(&|$)/, (_, p, e) => (e ? p : "")) : a.value}`)
    .sort();
  return `${el.tagName} ${attrs.join(" ")} ${el.tagName === "STYLE" ? el.textContent : ""}`;
}

// The router's head-region swap (client/router.js syncHead), except that a node the new page
// still has stays where it is: no stylesheet is fetched again, so nothing flashes.
function syncHead(doc) {
  const [start, end] = headRegion(document);
  const [nextStart, nextEnd] = headRegion(doc);
  const old = new Map();
  for (let n = start.nextSibling; n && n !== end; n = n.nextSibling) {
    if (n.nodeType === 1) {
      const k = headKey(n);
      if (!old.has(k)) old.set(k, []);
      old.get(k).push(n);
    }
  }
  const keep = new Set();
  const nodes = [];
  for (let n = nextStart.nextSibling; n && n !== nextEnd; n = n.nextSibling) {
    if (n.nodeType !== 1 || n.tagName === "SCRIPT") continue;
    const same = old.get(headKey(n))?.shift();
    if (same) keep.add(same);
    nodes.push(same || n.cloneNode(true));
  }
  for (let n = start.nextSibling; n && n !== end; ) {
    const after = n.nextSibling;
    if (!keep.has(n) && n.tagName !== "SCRIPT") n.remove();
    n = after;
  }
  for (const el of nodes) {
    if (window.__nowakiNonce && el.tagName === "STYLE") el.nonce = window.__nowakiNonce;
    end.before(el);
  }
}

// A slot fragment's stylesheets, into the head region (as the router adds them).
function addLinks(root) {
  const end = headRegion(document)?.[1];
  for (const l of root.querySelectorAll("link")) {
    if (document.head.querySelector(`link[href="${CSS.escape(l.getAttribute("href"))}"]`)) continue;
    end ? end.before(l.cloneNode()) : document.head.append(l.cloneNode());
  }
}

// Server-set attributes of <html> / <body> (data-nowaki-attrs), as client/router.js syncAttrs.
function syncAttrs(cur, next, always) {
  if (!cur || !next) return;
  const names = (el) => (el.getAttribute("data-nowaki-attrs") ?? "").split(" ").filter(Boolean);
  for (const attr of new Set([...always, ...names(cur), ...names(next), "data-nowaki-attrs"])) {
    const v = next.getAttribute(attr);
    if (v === null) cur.removeAttribute(attr);
    else cur.setAttribute(attr, v);
  }
}

// Page scripts (`export const scripts`) the page didn't load yet (as client/router.js).
function loadPageScripts(root) {
  for (const s of root.querySelectorAll("script[data-nowaki-script]")) {
    const src = s.getAttribute("src");
    if (!src || document.querySelector(`script[data-nowaki-script][src="${CSS.escape(src)}"]`)) continue;
    const el = document.createElement("script");
    el.type = "module";
    el.src = src;
    el.setAttribute("data-nowaki-script", "");
    if (window.__nowakiNonce) el.nonce = window.__nowakiNonce;
    document.head.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}

function showOverlay(message) {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute(
      "style",
      [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "background:rgba(8,10,16,0.94)",
        "color:#e6e6e6",
        "font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace",
        "padding:2.5rem 2rem",
        "overflow:auto",
      ].join(";"),
    );
    document.body.appendChild(el);
  }
  el.innerHTML =
    '<div style="max-width:920px;margin:0 auto">' +
    '<div style="color:#ff6b6b;font-weight:700;font-size:15px;margin-bottom:1rem">Nowaki — build error</div>' +
    '<pre style="white-space:pre-wrap;margin:0;color:#e6e6e6">' +
    escapeHtml(message) +
    "</pre>" +
    '<div style="margin-top:1.5rem;color:#8a8f98">Fix the error and save. This clears on the next successful build.</div>' +
    "</div>";
}

function clearOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}

const ws = new WebSocket(`ws://${location.host}${import.meta.env.BASE_URL}__nowaki/hmr`);

// One update at a time, in the order the server sent them.
let chain = Promise.resolve();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "error") {
    showOverlay(msg.message);
    window.dispatchEvent(new CustomEvent("nowaki:hmr", { detail: { type: "error" } }));
  } else if (msg.type === "hot" || msg.type === "css" || msg.type === "page") {
    clearOverlay();
    chain = chain.then(async () => {
      const started = performance.now();
      const run = msg.type === "hot" ? hot(msg) : msg.type === "css" ? css(msg) : page();
      // A page that failed to morph halfway is reloaded rather than left half-updated.
      const done = await run.catch((err) => {
        console.error("[nowaki] hot update failed:", err);
        return msg.type === "page" ? reload() : undefined;
      });
      if (done === false) return;
      const ms = Math.round(performance.now() - started);
      window.dispatchEvent(new CustomEvent("nowaki:hmr", { detail: { type: msg.type, ms } }));
    });
  } else if (msg.type === "reload") {
    clearOverlay();
    location.reload();
  }
});

// The dev toolbar (client/toolbar.js), once the page is idle. Off with `nowaki dev --no-toolbar` /
// NOWAKI_TOOLBAR=0 (data-toolbar="0" on this script) or per browser (its close button).
if (!document.querySelector('script[data-toolbar="0"]')) {
  let off = false;
  try {
    off = localStorage.getItem("nowaki:toolbar") === "off";
  } catch {}
  if (!off) (window.requestIdleCallback || setTimeout)(() => import("./toolbar.js").catch((err) => console.error("[nowaki] dev toolbar:", err)));
}

ws.addEventListener("close", () => {
  // wait for the dev server to restart, then reconnect
  const timer = setInterval(async () => {
    try {
      await fetch(import.meta.env.BASE_URL, { method: "HEAD" });
      clearInterval(timer);
      location.reload();
    } catch {}
  }, 500);
});
