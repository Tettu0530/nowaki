// HMR client + error overlay (dev only; never part of a build). Messages from dev.rs:
//   hot    islands (and the modules between them and an edit) were re-versioned: re-import them;
//          client/refresh.js swaps the components in place, so island state survives. Live
//          (Jetstream) islands re-render on the server with the state they hold.
//   css    stylesheets changed: re-run the CSS shim of each <style data-nowaki-css>, and replace
//          each <link href="/__nowaki/css?f=…"> once the new one has loaded (no flash).
//   page   a route or layout changed (re-rendered in place later; reloads for now).
//   reload anything else (config, env, session, content, removed files).

import { h, render } from "preact";

const OVERLAY_ID = "__nowaki_error_overlay";
const REFRESH_URL = "/node_modules/@nowaki-dev/runtime/client/refresh.js";

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
  } else if (msg.type === "hot" || msg.type === "css") {
    clearOverlay();
    chain = chain.then(async () => {
      const started = performance.now();
      await (msg.type === "hot" ? hot(msg) : css(msg)).catch((err) => console.error("[nowaki] hot update failed:", err));
      const ms = Math.round(performance.now() - started);
      window.dispatchEvent(new CustomEvent("nowaki:hmr", { detail: { type: msg.type, ms } }));
    });
  } else if (msg.type === "page" || msg.type === "reload") {
    clearOverlay();
    location.reload();
  }
});

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
