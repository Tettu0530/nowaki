// Client router. Intercepts internal <a> clicks, fetches the target HTML,
// swaps the body, and re-hydrates only the new islands (zero-JS pages do full navigations).

import { matchBoundary, matchPattern, createPageCache, shouldTransition } from "./router-core.js";

// The eager runtime (islands.js) exposes hydrate on window.
// Not importing islands.js here keeps the router a separate lazy chunk.
const hydrateIslands = (root) => window.__nowakiHydrateIslands?.(root);

const pageCache = createPageCache({ ttlMs: readCacheTtl(), max: 32 });
const scrollPos = new Map(); // history key -> scrollY
const slotSaves = new Map(); // history key -> { body, slots: [[<nowaki-slot>, its child nodes]] }
let curKey; // history key of the entry on screen (history.state has already moved on popstate)
let curDoc; // path + query of the document on screen, null while a boundary shows
let boundariesPromise = null; // result of /__nowaki/boundaries (fetched once)
let navToken = 0; // token guarding against racing navigations
let histIdx = 0; // history.state.i of the entry on screen (tells back from forward on popstate)
let navVt, navType; // the latest navigation's `vt` and `type` (see navigate)

// <meta name="nowaki-router-cache" content="seconds"> overrides the Router Cache TTL (default 30s, 0 disables).
function readCacheTtl() {
  if (typeof document === "undefined") return 30000;
  const m = document.querySelector('meta[name="nowaki-router-cache"]');
  const s = m && Number(m.getAttribute("content"));
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 30000;
}

function internalAnchor(target) {
  const a = target?.closest?.("a");
  if (!a) return null;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#")) return null;
  if (a.target && a.target !== "_self") return null;
  if (a.hasAttribute("download") || a.hasAttribute("data-no-router")) return null;
  let url;
  try {
    url = new URL(a.href, location.href);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  // Outside nowaki.config basePath is another app on the same host: a full load.
  if (import.meta.env.BASE_URL !== "/" && !underBase(url.pathname)) return null;
  // A path ending in a file name (/feed.xml, /og/a.png, /robots.txt) is a file, not a page.
  if (/\.[A-Za-z0-9]+$/.test(url.pathname.split("/").pop())) return null;
  return url;
}

// nowaki.config basePath. BASE_URL ("/app/", or "/") is inlined at build, and every use is guarded
// by a comparison with "/", so an app without a base ships none of this.
function underBase(p) {
  const base = import.meta.env.BASE_URL.slice(0, -1);
  return p === base || p.startsWith(base + "/");
}
// The path boundaries are matched by: the URL path without basePath.
function routePath(p) {
  if (import.meta.env.BASE_URL === "/" || !underBase(p)) return p;
  return p.slice(import.meta.env.BASE_URL.length - 1) || "/";
}

// Intercepting routes: a <nowaki-slot> on screen whose layout has intercepting files lists the URL
// patterns they take over (data-nowaki-intercepts, as the browser sees them). Navigating to one
// fetches just the slot's new content. Returns that slot element, or null.
function interceptFor(url) {
  for (const el of document.querySelectorAll("nowaki-slot[data-nowaki-slot]")) {
    try {
      if (JSON.parse(el.getAttribute("data-nowaki-intercepts")).some((p) => matchPattern(p, url.pathname))) return el;
    } catch {}
  }
  return null;
}

// Resolves to null for a response that isn't a page (a download, JSON, a redirect to another
// origin): the browser loads those itself. With `slot`, the server answers with that slot's
// fragment (x-nowaki-slot) when an intercepting file takes the URL, else with the page.
async function fetchPage(url, slot) {
  let res;
  const headers = { "x-nowaki-nav": "1" };
  if (slot) headers["x-nowaki-intercept"] = slot.getAttribute("data-nowaki-slot");
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    // A redirect to another origin fails CORS (x-nowaki-nav needs a preflight).
    if ((await fetch(url, { redirect: "manual" })).type === "opaqueredirect") return null;
    throw e;
  }
  const h = (n) => res.headers.get(n) || "";
  const page = /html/.test(h("content-type")) && !/^attachment/i.test(h("content-disposition"));
  // (A Response a fetch wrapper built itself has no url.)
  if (!page || (res.url && new URL(res.url).origin !== location.origin)) return null;
  const html = await res.text();
  return {
    doc: new DOMParser().parseFromString(html, "text/html"),
    finalUrl: res.redirected ? res.url : url.href.split("#")[0],
    status: res.status,
    slot: slot && res.headers.has("x-nowaki-slot"),
  };
}

// Fetch the SSR HTML for loading/error boundaries once and reuse it.
function loadBoundaries() {
  if (!boundariesPromise) {
    boundariesPromise = fetch(import.meta.env.BASE_URL + "__nowaki/boundaries", { headers: { "x-nowaki-nav": "1" } })
      .then((r) => (r.ok ? r.json() : { loading: [], error: [] }))
      .catch(() => ({ loading: [], error: [] }));
  }
  return boundariesPromise;
}

// Router Cache key: a slot's fragment is kept apart from the page at the same URL.
const cacheKey = (url, slot) => (slot ? "slot:" : "") + url.href.split("#")[0];

function prefetch(url) {
  const slot = interceptFor(url);
  if (pageCache.has(cacheKey(url, slot))) return;
  fetchPage(url, slot)
    .then((r) => {
      if (r?.status === 200) pageCache.set(cacheKey(url, r.slot), r);
    })
    .catch(() => {});
}

// `intercept`: whether a slot on screen may take the URL (not when going back to an entry that
// showed the full page). `vt`: the element that opted the link into a View Transition
// (data-nowaki-transition), false when the browser already animated a back/forward gesture, or
// null / undefined to let the pages decide. `type`: the transition's type, "forward" or "back".
async function navigate(url, { push = true, intercept = push, vt, type = "forward" } = {}) {
  const slot = intercept ? interceptFor(url) : null;
  const token = ++navToken;
  const go = (entry) => apply(entry, slot, push, token, url.hash);
  navVt = vt;
  navType = type;

  // Immediate Router Cache hit (no loading shown).
  const cached = pageCache.get(cacheKey(url, slot));
  if (cached) return go(cached);

  const body = document.body;
  const pending = fetchPage(url, slot).catch(() => 0);

  // Show loading after 150ms (no flicker on fast navigations). Opening a slot keeps the page: a
  // progress bar only.
  const timer = setTimeout(async () => {
    if (token !== navToken) return;
    if (slot) return showProgressBar();
    const { loading } = await loadBoundaries();
    if (token !== navToken) return;
    showLoading(matchBoundary(loading, import.meta.env.BASE_URL === "/" ? url.pathname : routePath(url.pathname)));
  }, 150);

  const result = await pending;
  clearTimeout(timer);
  if (token !== navToken) return; // superseded by a newer navigation

  if (result === 0) {
    if (slot) return location.assign(url.href);
    await showError(url, "Failed to load the page");
    return;
  }
  if (!result) {
    // Not a page: put back the page a loading boundary replaced, and let the browser have it.
    if (document.body !== body) {
      document.body.replaceWith(body);
      curDoc = location.pathname + location.search;
    }
    removeProgressBar();
    location.assign(url.href);
    return;
  }
  if (result.status === 200) pageCache.set(cacheKey(url, result.slot), result);
  return go(result);
}

// Applies a cached/fetched page (cloning its body keeps the cache intact), or a slot's fragment.
// Pages are cached without the #hash, and the link's own goes on the pushed URL. Resolves to the
// URL to scroll for, or to nothing after a slot swap (the page stays where it is) and after a swap
// a newer navigation superseded.
function apply(entry, slot, push, token, hash) {
  const { doc, finalUrl } = entry;
  // Opted in by the link, else by the page on screen or the one coming (`export const
  // viewTransition`, whose <meta> document.mjs puts in the head). A fragment has no head of its own.
  const opted = navVt ?? (vtPage(document) || vtPage(doc));
  if (!entry.slot) {
    return swap(opted, token, () => {
      if (push) scrollPos.set(curKey, window.scrollY);
      document.title = doc.title;
      syncHead(doc);
      document.body.replaceWith(stampNonce(doc.body.cloneNode(true)));
      if (push) history.pushState({ nowaki: (curKey = newKey()), i: ++histIdx }, "", finalUrl + hash);
      curDoc = location.pathname + location.search;
    }, () => {
      hydrateIslands(document);
      loadPageScripts(doc.head);
      syncLive();
      removeProgressBar();
      // Page scripts run once (they are modules); this is their cue to set up the new page's DOM.
      document.dispatchEvent(new CustomEvent("nowaki:page-load", { detail: { url: finalUrl } }));
      return finalUrl;
    });
  }
  // The fragment's stylesheets and page scripts (<template data-nowaki-head>), into the page's
  // head region so the next page swaps them out.
  const tpl = doc.querySelector("template[data-nowaki-head]");
  const body = stampNonce(doc.body.cloneNode(true));
  body.querySelector("template[data-nowaki-head]")?.remove();
  return swap(opted, token, () => {
    if (push) {
      scrollPos.set(curKey, window.scrollY);
      saveSlots(curKey);
    }
    if (tpl) {
      const end = headRegion(document)?.[1];
      for (const l of tpl.content.querySelectorAll("link")) {
        if (document.head.querySelector(`link[href="${CSS.escape(l.getAttribute("href"))}"]`)) continue;
        end ? end.before(l.cloneNode()) : document.head.append(l.cloneNode());
      }
    }
    slot.replaceChildren(...body.childNodes);
    if (push) history.pushState({ nowaki: (curKey = newKey()), i: ++histIdx, slot: 1 }, "", finalUrl + hash);
  }, () => {
    if (tpl) loadPageScripts(tpl.content);
    slotShown(slot);
    document.dispatchEvent(new CustomEvent("nowaki:page-load", { detail: { url: finalUrl, slot: slot.getAttribute("name") } }));
  });
}

// View Transitions are opt-in: a link with data-nowaki-transition (<Link viewTransition>), on the
// <a> or an ancestor, or a page that exports `viewTransition` (this <meta> in its head region).
const vtPage = (d) => !!d.querySelector('meta[name="nowaki-view-transition"]');

// Runs `update` (the DOM swap) and then `done` (hydration, page scripts, nowaki:page-load), only
// while `token` is still the latest navigation: checked when the swap runs, which a transition
// delays to the next frame. Inside document.startViewTransition when shouldTransition says so,
// else synchronously (as without View Transitions). Resolves to what `done` returns, or to false
// when a newer navigation superseded this one.
async function swap(opted, token, update, done) {
  let ran;
  const run = () => (ran = token === navToken) && update();
  if (!shouldTransition(opted, document.startViewTransition, matchMedia("(prefers-reduced-motion:reduce)").matches)) {
    run();
  } else {
    const t = document.startViewTransition(run);
    // A transition type (:active-view-transition-type(back)) where the browser has them.
    t.types?.add(navType);
    await t.updateCallbackDone;
  }
  return ran && done();
}

// After a slot's content changed: hydrate its islands, join live islands, done loading.
function slotShown(slot) {
  curDoc = location.pathname + location.search;
  hydrateIslands(slot);
  syncLive();
  removeProgressBar();
}

// What the intercepting slots on screen show, kept (the nodes themselves, islands and all) for
// the history entry being left, so going back and forth puts it back as it was.
function saveSlots(key) {
  const slots = [...document.querySelectorAll("nowaki-slot[data-nowaki-slot]")].map((el) => [el, [...el.childNodes]]);
  if (!slots.length) return;
  slotSaves.delete(key);
  slotSaves.set(key, { body: document.body, slots });
  if (slotSaves.size > 50) slotSaves.delete(slotSaves.keys().next().value);
}

// Puts back what saveSlots kept for an entry, if the page it was taken from is still on screen.
function restoreSlots(key) {
  const save = slotSaves.get(key);
  if (save?.body !== document.body) return false;
  for (const [el, nodes] of save.slots) el.replaceChildren(...nodes);
  for (const [el] of save.slots) slotShown(el);
  return true;
}

// Page scripts (`export const scripts`) of the page navigated to. A module runs once per URL, so
// one the previous page already loaded doesn't run again: it listens for nowaki:page-load instead.
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

// Scripts parsed by DOMParser never run, and the router doesn't run the new <body>'s scripts:
// that would also run whatever else got into the page's HTML. The one body script a page may need
// that an earlier page didn't load is live.js (id="nowaki-live", added by the server). Once loaded
// it exposes window.__nowakiLive, and the router asks it to sync with the new page's islands
// (join them on the open socket, or close it on a page without any).
function syncLive() {
  if (window.__nowakiLive) return window.__nowakiLive.sync();
  // Same origin only: like a full load under the 'self' policy. The framework's script comes after
  // the page's own HTML, so the last one wins.
  const sameOrigin = (s) => {
    try {
      const url = new URL(s.getAttribute("src"), location.href);
      return url.origin === location.origin ? url : null;
    } catch {
      return null;
    }
  };
  const old = [...document.body.querySelectorAll("script#nowaki-live[src]")].reverse().find(sameOrigin);
  if (!old) return;
  const url = sameOrigin(old);
  const el = document.createElement("script");
  el.type = "module";
  el.src = url.href;
  const transport = old.getAttribute("data-live-transport");
  if (transport !== null) el.setAttribute("data-live-transport", transport);
  // Under NOWAKI_CSP the server nonced it (its nonce slot survives the clone). It carries this
  // document's nonce only then: a script never gains a nonce it didn't have.
  if (window.__nowakiNonce && (old.nonce || old.getAttribute("nonce"))) el.nonce = window.__nowakiNonce;
  old.replaceWith(el);
}

// Under a CSP nonce, <style> from another response carries that response's nonce; re-stamp it with
// this document's (captured by islands.js at startup, since <head> swaps may drop the nonced script).
function stampNonce(root) {
  const nonce = window.__nowakiNonce;
  if (!nonce) return root;
  for (const el of root.querySelectorAll("style")) el.nonce = nonce;
  return root;
}

// Loading boundary (swaps body for its skeleton if present). Otherwise, the default progress bar.
function showLoading(boundary) {
  if (boundary) {
    curDoc = null;
    const tmp = new DOMParser().parseFromString(`<body>${boundary.html}</body>`, "text/html");
    document.body.replaceWith(stampNonce(tmp.body));
  } else {
    showProgressBar();
  }
}

// Error boundary (if present, shows it with the message in data-nowaki-error and retry wired to data-nowaki-reset).
async function showError(url, message) {
  curDoc = null;
  const { error } = await loadBoundaries();
  const boundary = matchBoundary(error, import.meta.env.BASE_URL === "/" ? url.pathname : routePath(url.pathname));
  if (boundary) {
    const tmp = new DOMParser().parseFromString(`<body>${boundary.html}</body>`, "text/html");
    for (const slot of tmp.body.querySelectorAll("[data-nowaki-error]")) slot.textContent = message;
    document.body.replaceWith(stampNonce(tmp.body));
  } else {
    showDefaultError(message);
  }
  for (const btn of document.querySelectorAll("[data-nowaki-reset]")) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(url, { push: false });
    });
  }
  removeProgressBar();
}

function showDefaultError(message) {
  const body = document.createElement("body");
  body.innerHTML = `<main style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:6rem auto;padding:0 1.25rem">
    <h1 style="font-size:1.25rem;margin:0 0 .5rem">Something went wrong</h1>
    <p style="color:#56616f;margin:0 0 1.25rem">${escapeHtml(message)}</p>
    <button data-nowaki-reset type="button" style="font:inherit;cursor:pointer;border:1px solid #d7dbe0;background:#fff;border-radius:8px;padding:.5rem .9rem">Try again</button>
  </main>`;
  document.body.replaceWith(body);
}

// Keep the current page and show just a bar at the top.
let progressEl = null;
function showProgressBar() {
  if (progressEl) return;
  progressEl = document.createElement("div");
  progressEl.id = "nowaki-progress";
  progressEl.setAttribute("aria-hidden", "true");
  progressEl.style.cssText =
    "position:fixed;top:0;left:0;height:3px;width:0;z-index:2147483647;background:#0e7c86;transition:width .2s ease;box-shadow:0 0 8px rgba(14,124,134,.6)";
  document.body.appendChild(progressEl);
  requestAnimationFrame(() => {
    if (progressEl) progressEl.style.width = "80%";
  });
}
function removeProgressBar() {
  if (!progressEl) return;
  const el = progressEl;
  progressEl = null;
  el.style.width = "100%";
  setTimeout(() => el.remove(), 200);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

// The server wraps each page's own <head> content (preloads + `export const head`) in
// <meta name="nowaki-head" content="start|end">.
function headRegion(d) {
  const marks = d.head.querySelectorAll('meta[name="nowaki-head"]');
  return marks.length === 2 ? marks : null;
}

// Replace the page-owned <head> region with the new page's. Anything outside it (island CSS,
// styles injected at runtime by CSS-in-JS libraries) is left alone. <html lang>/<dir> follow too.
function syncHead(doc) {
  const cur = headRegion(document);
  const next = headRegion(doc);
  if (cur && next) {
    while (cur[0].nextSibling && cur[0].nextSibling !== cur[1]) cur[0].nextSibling.remove();
    for (let n = next[0].nextSibling; n && n !== next[1]; n = n.nextSibling) {
      if (n.nodeType !== 1 || n.tagName === "SCRIPT") continue;
      const el = n.cloneNode(true);
      if (window.__nowakiNonce && el.tagName === "STYLE") el.nonce = window.__nowakiNonce;
      cur[1].before(el);
    }
  } else {
    // Older servers without markers: sync meta/link only, as before.
    const synced = (el) => (el.tagName === "META" || el.tagName === "LINK") && !el.hasAttribute("data-nowaki-css");
    for (const el of [...document.head.children]) if (synced(el)) el.remove();
    for (const el of [...doc.head.children]) if (synced(el)) document.head.appendChild(el.cloneNode(true));
  }
  syncAttrs(document.documentElement, doc.documentElement, ["lang", "dir"]);
  syncAttrs(document.body, doc.body, []);
}

// Copies the attributes the server set from `htmlAttrs` / `bodyAttrs` (named in
// data-nowaki-attrs) from the next page's element: the ones it sets, and the ones the current
// page had that it doesn't. Attributes client code added (a theme toggle's data-theme) stay.
function syncAttrs(cur, next, always) {
  if (!cur || !next) return;
  const names = (el) => (el.getAttribute("data-nowaki-attrs") ?? "").split(" ").filter(Boolean);
  for (const attr of new Set([...always, ...names(cur), ...names(next), "data-nowaki-attrs"])) {
    const v = next.getAttribute(attr);
    if (v === null) cur.removeAttribute(attr);
    else cur.setAttribute(attr, v);
  }
}

const newKey = () => Math.random().toString(36).slice(2);

// The current entry's key. Entries the browser added (a #hash link) get one on first sight, and
// an index after the entry they were added from. histIdx follows the entry.
function historyKey() {
  if (!history.state?.nowaki) {
    history.replaceState({ ...(history.state ?? {}), nowaki: newKey(), i: histIdx + 1 }, "");
  }
  histIdx = history.state.i | 0;
  return history.state.nowaki;
}

// Like the browser on a fragment navigation: the element with that id (or name), else the top.
function scrollToHash(hash) {
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {}
  const el = id && (document.getElementById(id) || document.getElementsByName(id)[0]);
  if (el) el.scrollIntoView();
  else window.scrollTo(0, 0);
}

export function installRouter() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__nowakiRouter) return;
  window.__nowakiRouter = true;
  curKey = historyKey();
  curDoc = location.pathname + location.search;
  loadBoundaries();

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const url = internalAnchor(e.target);
    if (!url) return;
    if (url.pathname === location.pathname && url.search === location.search) {
      return; // leave same-page (hash etc.) to the browser
    }
    e.preventDefault();
    navigate(url, { push: true, vt: e.target.closest("[data-nowaki-transition]") }).then((final) => final && scrollToHash(url.hash));
  });

  const onHover = (e) => {
    const url = internalAnchor(e.target);
    if (url) prefetch(url);
  };
  document.addEventListener("mouseover", onHover, { passive: true });
  document.addEventListener("touchstart", onHover, { passive: true });

  // Back/forward, and #hash links (the browser scrolls to those after this event).
  window.addEventListener("popstate", (e) => {
    // The entry left is curKey: history.state is already the one returned to.
    scrollPos.set(curKey, window.scrollY);
    saveSlots(curKey);
    const from = histIdx;
    const key = (curKey = historyKey());
    const restore = () => {
      const y = scrollPos.get(key);
      if (y === undefined) scrollToHash(location.hash);
      else window.scrollTo(0, y);
    };
    // Same document, another #hash: nothing to fetch (and a pending navigation is dropped). An
    // entry an intercepting slot was opened or closed on gets the slot's content back.
    if (restoreSlots(key) || location.pathname + location.search === curDoc) {
      navToken++;
      removeProgressBar();
      return restore();
    }
    // An entry a slot showed (and nothing kept) asks for the fragment again.
    // A swipe the browser already animated (hasUAVisualTransition) gets no View Transition on top.
    navigate(new URL(location.href), {
      push: false,
      intercept: !!history.state?.slot,
      vt: e.hasUAVisualTransition ? false : null,
      type: histIdx < from ? "back" : "forward",
    }).then((final) => final && key === curKey && restore());
  });

  // disable the browser's default scroll restoration (we manage it)
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
}

installRouter();
