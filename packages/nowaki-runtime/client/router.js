// Client router. Intercepts internal <a> clicks, fetches the target HTML,
// swaps the body, and re-hydrates only the new islands (zero-JS pages do full navigations).

import { matchBoundary, createPageCache } from "./router-core.js";

// The eager runtime (islands.js) exposes hydrate on window.
// Not importing islands.js here keeps the router a separate lazy chunk.
const hydrateIslands = (root) => window.__nowakiHydrateIslands?.(root);

const pageCache = createPageCache({ ttlMs: readCacheTtl(), max: 32 });
const scrollPos = new Map(); // history key -> scrollY
let boundariesPromise = null; // result of /__nowaki/boundaries (fetched once)
let navToken = 0; // token guarding against racing navigations

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
  return url;
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "x-nowaki-nav": "1" } });
  const html = await res.text();
  return {
    doc: new DOMParser().parseFromString(html, "text/html"),
    finalUrl: res.redirected ? res.url : url.toString(),
    status: res.status,
  };
}

// Fetch the SSR HTML for loading/error boundaries once and reuse it.
function loadBoundaries() {
  if (!boundariesPromise) {
    boundariesPromise = fetch("/__nowaki/boundaries", { headers: { "x-nowaki-nav": "1" } })
      .then((r) => (r.ok ? r.json() : { loading: [], error: [] }))
      .catch(() => ({ loading: [], error: [] }));
  }
  return boundariesPromise;
}

function prefetch(url) {
  const key = url.toString();
  if (pageCache.has(key)) return;
  fetchPage(url)
    .then((r) => {
      if (r.status === 200) pageCache.set(key, r);
    })
    .catch(() => {});
}

async function navigate(url, { push = true } = {}) {
  const key = url.toString();
  const token = ++navToken;

  // Immediate Router Cache hit (no loading shown).
  const cached = pageCache.get(key);
  if (cached) {
    applyDocument(cached, push, token);
    return cached.finalUrl;
  }

  const pending = fetchPage(url).then(
    (r) => r,
    () => null,
  );

  // Show loading after 150ms (no flicker on fast navigations).
  const timer = setTimeout(async () => {
    if (token !== navToken) return;
    const { loading } = await loadBoundaries();
    if (token !== navToken) return;
    showLoading(matchBoundary(loading, url.pathname));
  }, 150);

  const result = await pending;
  clearTimeout(timer);
  if (token !== navToken) return; // superseded by a newer navigation

  if (!result) {
    await showError(url, "Failed to load the page");
    return;
  }
  if (result.status === 200) pageCache.set(key, result);
  applyDocument(result, push, token);
  return result.finalUrl;
}

// Apply a cached/fetched document to the live DOM (clones body to keep the cache intact).
function applyDocument(entry, push, token) {
  if (token !== undefined && token !== navToken) return;
  scrollPos.set(historyKey(), window.scrollY);
  const { doc, finalUrl } = entry;
  document.title = doc.title;
  syncHead(doc);
  document.body.replaceWith(stampNonce(doc.body.cloneNode(true)));
  if (push) {
    const k = String(Date.now()) + Math.round(performance.now());
    history.pushState({ nowaki: k }, "", finalUrl);
  }
  hydrateIslands(document);
  removeProgressBar();
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
    const tmp = new DOMParser().parseFromString(`<body>${boundary.html}</body>`, "text/html");
    document.body.replaceWith(stampNonce(tmp.body));
  } else {
    showProgressBar();
  }
}

// Error boundary (if present, shows it with the message in data-nowaki-error and retry wired to data-nowaki-reset).
async function showError(url, message) {
  const { error } = await loadBoundaries();
  const boundary = matchBoundary(error, url.pathname);
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

function historyKey() {
  if (!history.state?.nowaki) {
    history.replaceState({ ...(history.state ?? {}), nowaki: "init" }, "");
  }
  return history.state.nowaki;
}

export function installRouter() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__nowakiRouter) return;
  window.__nowakiRouter = true;
  historyKey();
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
    navigate(url, { push: true }).then((final) => {
      window.scrollTo(0, 0);
      if (final) scrollPos.set(historyKey(), 0);
    });
  });

  const onHover = (e) => {
    const url = internalAnchor(e.target);
    if (url) prefetch(url);
  };
  document.addEventListener("mouseover", onHover, { passive: true });
  document.addEventListener("touchstart", onHover, { passive: true });

  window.addEventListener("popstate", () => {
    const url = new URL(location.href);
    navigate(url, { push: false }).then(() => {
      const y = scrollPos.get(historyKey()) ?? 0;
      window.scrollTo(0, y);
    });
  });

  // disable the browser's default scroll restoration (we manage it)
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
}

installRouter();
