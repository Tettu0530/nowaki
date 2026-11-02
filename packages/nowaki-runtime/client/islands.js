// Islands hydration runtime (the client's eager entry). Dynamically imports only island modules,
// using the strategy from the `client` attribute (client:* directive). Pages themselves ship no JS.

import { h, hydrate, render } from "preact";

export function hydrateIslands(root = document) {
  for (const el of root.querySelectorAll("nowaki-island")) {
    if (el.__nowakiHydrated) continue; // prevent double hydration (on SPA navigation)
    el.__nowakiHydrated = true;
    schedule(el, el.getAttribute("client") || "load");
  }
}

function schedule(el, strategy) {
  const go = () => mount(el, strategy === "only");
  if (strategy === "idle") {
    "requestIdleCallback" in window ? requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 1);
  } else if (strategy === "visible") {
    whenVisible(el, go);
  } else if (strategy === "media") {
    whenMedia(el.getAttribute("client-media") || "", go);
  } else {
    go(); // load / only / unknown run immediately
  }
}

function mount(el, clientOnly) {
  const src = el.getAttribute("src");
  const props = JSON.parse(el.getAttribute("props") || "{}");
  import(src).then(
    (mod) => (clientOnly ? render : hydrate)(h(mod.default, props), el),
    (err) => console.error(`[nowaki] failed to load island ${src}:`, err),
  );
}

// Runs once when the element becomes visible via IntersectionObserver (immediately if unsupported).
// <nowaki-island> is display:contents with no box, so observe its SSR'd children.
function whenVisible(el, go) {
  if (!("IntersectionObserver" in window)) return go();
  const target = el.firstElementChild || el;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        io.disconnect();
        go();
        return;
      }
    }
  });
  io.observe(target);
}

function whenMedia(query, go) {
  if (!query || !window.matchMedia) return go();
  const mql = window.matchMedia(query);
  if (mql.matches) return go();
  const on = () => {
    if (mql.matches) {
      mql.removeEventListener("change", on);
      go();
    }
  };
  mql.addEventListener("change", on);
}

// Intercepts `<form action={serverFn}>`. Preact puts the server fn's toString ("__nowaki_action:<id>")
// in the action attribute, so we catch submit here and send FormData to the server fn (no navigation).
// The result is dispatched on the form as a `nowaki:action` event (detail: { id, ok, result, error }).
const ACTION_PREFIX = "__nowaki_action:";
document.addEventListener("submit", async (ev) => {
  const form = ev.target;
  if (!(form instanceof HTMLFormElement)) return;
  const action = form.getAttribute("action") || "";
  if (!action.startsWith(ACTION_PREFIX)) return;
  ev.preventDefault();
  const id = action.slice(ACTION_PREFIX.length);
  const fields = Object.fromEntries(new FormData(form));
  let ok = false;
  let result;
  let error;
  try {
    const res = await fetch("/__nowaki/fn", {
      method: "POST",
      // x-nowaki-rpc is required by the server's CSRF gate (functions.mjs).
      headers: { "content-type": "application/json", "x-nowaki-rpc": "1" },
      body: JSON.stringify({ id, args: [fields] }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    ok = res.ok;
    result = ok ? (data ? data.result : null) : undefined;
    error = data && data.error;
  } catch (e) {
    error = String(e);
  }
  form.dispatchEvent(new CustomEvent("nowaki:action", { bubbles: true, detail: { id, ok, result, error } }));
});

// The SPA router calls hydrate via window (kept separate so islands.js isn't bundled twice).
if (typeof window !== "undefined") window.__nowakiHydrateIslands = hydrateIslands;

hydrateIslands();

// To keep first load small, lazily load the router chunk the server injected into data-router when idle
// (clicks before it loads do full navigations).
if (typeof document !== "undefined") {
  const runtimeEl = document.getElementById("nowaki-runtime");
  const routerSrc = runtimeEl && runtimeEl.getAttribute("data-router");
  if (routerSrc) {
    const load = () => import(routerSrc).catch(() => {});
    if ("requestIdleCallback" in window) requestIdleCallback(load, { timeout: 800 });
    else setTimeout(load, 1);
  }
}
