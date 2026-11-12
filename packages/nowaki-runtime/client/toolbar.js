// Dev toolbar (nowaki dev only; never part of a build). client/hmr.js imports it once the page is
// idle, unless `nowaki dev --no-toolbar` / NOWAKI_TOOLBAR=0 put data-toolbar="0" on its script or
// this browser closed it (localStorage "nowaki:toolbar" = "off").
//
// It shows what the dev MCP endpoint knows about the page on screen, from
// GET /__nowaki/devtools?url=… (crates/nowaki/src/mcp.rs `devtools`, loopback only: a LAN client
// under --host gets 403 and the toolbar removes itself), plus what only the browser knows: the
// Server-Timing of the last load (the navigation entry, or the nowaki:page-load detail after a
// client navigation or an HMR page update) and each island element's hydration state.
//
// Plain DOM in an open Shadow DOM root, so it shares nothing with the app (no Preact instance, no
// styles either way). Styles come from a constructed stylesheet (adoptedStyleSheets), or a <style>
// with the page's CSP nonce where that isn't supported. Text goes in with textContent only.

const BASE = import.meta.env.BASE_URL;
const ENDPOINT = BASE + "__nowaki/devtools";
const TABS = [
  ["page", "Page"],
  ["islands", "Islands"],
  ["js", "JS"],
  ["isr", "ISR"],
  ["live", "Live"],
  ["errors", "Errors"],
];
const PHASES = { mw: "middleware", loader: "loader", render: "render", action: "action", isr: "ISR", total: "total" };

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.tb {
  --bg: #ffffff; --fg: #1d2129; --muted: #626a78; --line: #dde1e8; --chip: #f1f3f6;
  --accent: #2f6fdd; --ok: #1d8a4e; --warn: #b26a00; --bad: #c62f2f;
  color-scheme: light dark;
  position: fixed; left: 12px; bottom: 12px; z-index: 2147483646;
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .tb { --bg: #161a21; --fg: #e3e6ec; --muted: #9aa3b2; --line: #2b313c; --chip: #222833;
    --accent: #79a6ff; --ok: #4fc483; --warn: #e0a43a; --bad: #ff7a7a; }
}
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: 14px; background: var(--bg);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .18); opacity: .88;
}
.pill:hover, .pill[aria-expanded="true"] { opacity: 1; }
.logo { font-weight: 700; letter-spacing: .02em; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--bad); }
.dot.off { background: var(--muted); }
.panel {
  position: absolute; left: 0; bottom: 36px; width: min(440px, calc(100vw - 24px));
  max-height: min(62vh, 560px); display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .22); overflow: hidden;
}
.panel[hidden] { display: none; }
@media (prefers-reduced-motion: no-preference) {
  .panel { animation: rise .12s ease-out; }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
}
.head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { border: 0; background: none; padding: 2px 6px; border-radius: 4px; color: var(--muted); }
.icon:hover { background: var(--chip); color: var(--fg); }
.tabs { display: flex; gap: 2px; padding: 4px 6px 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab { border: 0; background: none; padding: 5px 8px; border-bottom: 2px solid transparent; color: var(--muted); white-space: nowrap; }
.tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
.count { margin-left: 4px; padding: 0 5px; border-radius: 8px; background: var(--chip); font-size: 11px; }
.count.bad { background: var(--bad); color: #fff; }
.body { padding: 8px 10px 10px; overflow: auto; }
.row { display: flex; gap: 8px; padding: 3px 0; align-items: baseline; }
.k { flex: 0 0 96px; color: var(--muted); }
.v { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.sec { margin: 10px 0 4px; font-weight: 600; }
.sec:first-child { margin-top: 0; }
.muted { color: var(--muted); }
.note { color: var(--muted); margin-top: 6px; }
.chip { display: inline-block; padding: 0 6px; margin: 1px 4px 1px 0; border-radius: 4px; background: var(--chip); font-size: 11px; }
.chip.live { color: var(--accent); }
.chip.warn { color: var(--warn); }
.chip.bad { color: var(--bad); }
.chip.ok { color: var(--ok); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
ul { margin: 0; padding: 0; list-style: none; }
li { padding: 4px 0; border-top: 1px solid var(--line); }
li:first-child { border-top: 0; }
.bar { height: 6px; border-radius: 3px; background: var(--chip); margin: 6px 0 2px; overflow: hidden; }
.fill { height: 100%; background: var(--ok); }
.fill.over { background: var(--bad); }
table { border-collapse: collapse; width: 100%; }
td { padding: 2px 0; }
td.n { text-align: right; font-variant-numeric: tabular-nums; }
details pre { white-space: pre-wrap; margin: 4px 0 0; max-height: 160px; overflow: auto; }
`;

const ui = { tab: "page", open: false };
try {
  Object.assign(ui, JSON.parse(store.get("nowaki:toolbar-ui") || "{}"));
} catch {}
const saveUi = () => store.set("nowaki:toolbar-ui", JSON.stringify({ tab: ui.tab, open: ui.open }));

let data = null;
let failed = null;
let timing = { source: "load", entries: navTiming() };
let lastHmr = null;
let lastOk = 0;
const loadedAt = Date.now();

const host = document.createElement("nowaki-toolbar");
const root = host.attachShadow({ mode: "open" });
try {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
} catch {
  const style = document.createElement("style");
  if (window.__nowakiNonce) style.nonce = window.__nowakiNonce;
  style.textContent = CSS;
  root.append(style);
}

// h("div", { class: "x", onclick: fn }, child, "text", [more])
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const wrap = h("div", { class: "tb", role: "region", "aria-label": "Nowaki dev toolbar" });
const dot = h("span", { class: "dot off", "aria-hidden": "true" });
const pillLabel = h("span", { class: "muted" });
const pill = h(
  "button",
  { class: "pill", type: "button", "aria-expanded": "false", "aria-controls": "nowaki-tb-panel", title: "Nowaki dev toolbar", onclick: () => setOpen(!ui.open) },
  dot,
  h("span", { class: "logo" }, "nowaki"),
  pillLabel,
);
const title = h("div", { class: "title" });
const tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Toolbar sections" });
const body = h("div", { class: "body", role: "tabpanel", tabindex: "0" });
const panel = h(
  "div",
  { class: "panel", id: "nowaki-tb-panel", hidden: true },
  h(
    "div",
    { class: "head" },
    title,
    h("button", { class: "icon", type: "button", title: "Collapse (Esc)", "aria-label": "Collapse the toolbar", onclick: () => setOpen(false) }, "–"),
    h("button", { class: "icon", type: "button", "data-action": "close", title: "Hide the toolbar in this browser", "aria-label": "Hide the toolbar in this browser", onclick: close }, "×"),
  ),
  tabBar,
  body,
);
wrap.append(panel, pill);
root.append(wrap);
wrap.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.open) {
    setOpen(false);
    pill.focus();
  }
});
// Outside <body>: client navigations replace the body, HMR morphs it; this stays put.
document.documentElement.append(host);

function setOpen(open) {
  ui.open = open;
  saveUi();
  pill.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
  if (open) {
    render();
    if (data) refresh();
  }
}

function close() {
  store.set("nowaki:toolbar", "off");
  stop();
  console.info('[nowaki] dev toolbar hidden in this browser. Bring it back with localStorage.removeItem("nowaki:toolbar") and a reload.');
}

function stop() {
  host.remove();
  document.removeEventListener("nowaki:page-load", onPageLoad);
  window.removeEventListener("nowaki:hmr", onHmr);
}

// --- data ---

function navTiming() {
  const nav = performance.getEntriesByType("navigation")[0];
  if (!nav) return [];
  const out = (nav.serverTiming || []).map((t) => ({ name: t.name, dur: t.duration, desc: t.description }));
  if (nav.responseStart > 0) out.push({ name: "ttfb", dur: nav.responseStart - nav.requestStart, desc: "time to first byte (browser)" });
  return out;
}

// `mw;dur=1.2, loader;dur=3.4;desc="x"` (a Server-Timing header) → entries.
function parseTiming(header) {
  const out = [];
  for (const part of String(header || "").split(",")) {
    const [name, ...params] = part.split(";").map((s) => s.trim());
    if (!name) continue;
    const e = { name, dur: 0, desc: "" };
    for (const p of params) {
      const [k, v = ""] = p.split("=");
      if (k === "dur") e.dur = Number(v) || 0;
      else if (k === "desc") e.desc = v.replace(/^"|"$/g, "");
    }
    out.push(e);
  }
  return out;
}

let inflight = null;
let again = false;
async function refresh() {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      const res = await fetch(`${ENDPOINT}?url=${encodeURIComponent(location.pathname + location.search)}`, { cache: "no-store", headers: { accept: "application/json" } });
      // Not on loopback (`nowaki dev --host` from another device): the data isn't for this client.
      if (res.status === 403 || res.status === 404) return stop();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      failed = null;
    } catch (err) {
      failed = String(err?.message || err);
    }
    render();
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
    if (again) {
      again = false;
      refresh();
    }
  }
}

function onPageLoad(e) {
  const t = e.detail?.timing;
  timing = { source: "navigation", entries: t ? parseTiming(t) : [] };
  refresh();
}

function onHmr(e) {
  const d = e.detail || {};
  lastHmr = { type: d.type, ms: d.ms, at: Date.now() };
  if (d.type !== "error") lastOk = lastHmr.at;
  if (d.type === "page") timing.source = "HMR page update";
  refresh();
}

document.addEventListener("nowaki:page-load", onPageLoad);
window.addEventListener("nowaki:hmr", onHmr);

// --- rendering ---

// Text with `code` spans.
const md = (text) => text.split("`").map((part, i) => (i % 2 ? h("code", {}, part) : part));
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const ms = (n) => `${Number(n).toFixed(1)} ms`;
const row = (k, ...v) => h("div", { class: "row" }, h("div", { class: "k" }, k), h("div", { class: "v" }, ...v));
const sec = (text) => h("div", { class: "sec" }, text);

// A source link through NOWAKI_EDITOR's template (`vscode://file/{file}:{line}:{column}`), or plain
// text without one. `ref` is `routes/x.tsx` or `routes/x.tsx:12:5`, relative to the app root.
function source(ref) {
  if (!ref) return null;
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(ref);
  const file = m[1];
  const tpl = data?.editor;
  const label = h("code", {}, ref);
  if (!tpl || /^\s*(javascript|data|vbscript|blob):/i.test(tpl) || !data.root) return label;
  let abs = `${data.root.replace(/\/$/, "")}/${file}`;
  // `vscode://file/{file}` wants `vscode://file/Users/…`, not `file//Users/…`.
  if (tpl.includes("/{file}") && abs.startsWith("/")) abs = abs.slice(1);
  const href = tpl
    .replaceAll("{file}", encodeURI(abs))
    .replaceAll("{line}", m[2] || "1")
    .replaceAll("{column}", m[3] || "1");
  return h("a", { href, title: "Open in the editor (NOWAKI_EDITOR)", "data-source": ref }, label);
}

function onScreenIslands() {
  const out = [];
  for (const el of document.querySelectorAll("nowaki-island, nowaki-live")) {
    if (el.parentElement?.closest("nowaki-island, nowaki-live")) continue;
    if (el.localName === "nowaki-live") {
      out.push({ name: el.getAttribute("name"), kind: "live", state: "server-rendered" });
      continue;
    }
    const src = el.getAttribute("src") || "";
    const name = src.split("/").pop().replace(/\.[^.]+$/, "");
    const strategy = el.getAttribute("client") || "load";
    // islands.js marks an element when it schedules it; Preact keeps its tree on the element (`__k`).
    const state = !el.__nowakiHydrated ? "not hydrated" : el.__k ? "hydrated" : `waiting (${strategy})`;
    out.push({ name, kind: "client", strategy, state });
  }
  return out;
}

// The newest error, when it is news: since shortly before this document loaded (the dev error
// page reloads into it) and not followed by a successful hot update.
function recentError() {
  const e = data?.errors?.errors?.[0];
  const at = e ? Date.parse(e.time) : 0;
  return e && at >= loadedAt - 30_000 && !(lastOk > at) ? e : null;
}

function status() {
  if (failed) return ["off", "dev server unreachable"];
  if (recentError()) return ["bad", "error"];
  const js = data?.page?.js;
  if (js?.budgetKB != null && js.estimate.gzipBytes / 1024 > js.budgetKB) return ["bad", "over budget"];
  return [data ? "" : "off", ""];
}

function render() {
  const [cls, note] = status();
  dot.className = `dot ${cls}`;
  const route = data?.page?.route;
  pillLabel.textContent = note || route?.pattern || "";
  host.setAttribute("data-status", cls || "ok");
  if (!ui.open) return;
  title.textContent = route ? `${route.pattern}  ·  ${route.file}` : data?.page?.path || location.pathname;
  const errCount = data?.errors?.errors?.length || 0;
  tabBar.replaceChildren(
    ...TABS.map(([id, label]) =>
      h(
        "button",
        {
          class: "tab",
          type: "button",
          role: "tab",
          "data-tab": id,
          "aria-selected": String(ui.tab === id),
          tabindex: ui.tab === id ? "0" : "-1",
          onclick: () => selectTab(id),
          onkeydown: tabKeys,
        },
        label,
        id === "errors" && errCount ? h("span", { class: `count ${recentError() ? "bad" : ""}` }, errCount) : null,
      ),
    ),
  );
  body.setAttribute("data-panel", ui.tab);
  body.replaceChildren(...panelContent());
}

function selectTab(id) {
  ui.tab = id;
  saveUi();
  render();
  tabBar.querySelector(`[data-tab="${id}"]`)?.focus();
  // Live connections, errors and revalidations change without a page load.
  refresh();
}

function tabKeys(e) {
  const i = TABS.findIndex(([id]) => id === ui.tab);
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (step) {
    e.preventDefault();
    selectTab(TABS[(i + step + TABS.length) % TABS.length][0]);
  }
}

function panelContent() {
  if (failed && !data) return [h("div", { class: "muted" }, `Couldn't reach the dev server (${failed}).`)];
  if (!data) return [h("div", { class: "muted" }, "Loading…")];
  const page = data.page || {};
  if (page.error && ui.tab !== "errors" && ui.tab !== "live") return [h("div", { class: "muted" }, page.error)];
  switch (ui.tab) {
    case "islands":
      return islandsPanel(page);
    case "js":
      return jsPanel(page);
    case "isr":
      return isrPanel(page);
    case "live":
      return livePanel();
    case "errors":
      return errorsPanel();
    default:
      return pagePanel(page);
  }
}

function pagePanel(page) {
  const r = page.route;
  const out = [];
  if (r) {
    out.push(row("route", h("code", {}, r.pattern), " ", h("span", { class: "chip" }, r.kind)));
    out.push(row("file", source(r.file)));
    if (r.params && Object.keys(r.params).length) out.push(row("params", h("code", {}, JSON.stringify(r.params))));
    if (r.loadError) out.push(row("load error", h("span", { class: "chip bad" }, r.loadError)));
  } else {
    out.push(row("route", h("span", { class: "muted" }, "no route matches (404)")));
    if (page.notFound) out.push(row("404 page", source(page.notFound)));
  }
  if (page.locale) out.push(row("locale", page.locale));
  out.push(row("layouts", page.layouts?.length ? page.layouts.map((f) => h("div", {}, source(f))) : h("span", { class: "muted" }, "none")));
  out.push(row("middleware", page.middleware?.length ? page.middleware.map((f) => h("div", {}, source(f))) : h("span", { class: "muted" }, "none")));
  out.push(sec(`Timings (${timing.source})`));
  if (timing.entries.length) {
    out.push(
      h(
        "table",
        { "data-timings": "" },
        timing.entries.map((t) => h("tr", {}, h("td", {}, PHASES[t.name] || t.name, t.desc && t.name !== "ttfb" ? h("span", { class: "muted" }, ` ${t.desc}`) : null), h("td", { class: "n" }, t.dur || !t.desc ? ms(t.dur) : t.desc))),
      ),
    );
  } else {
    out.push(h("div", { class: "muted" }, "No Server-Timing on this response."));
  }
  if (lastHmr) out.push(h("div", { class: "note" }, `Last HMR update: ${lastHmr.type}${lastHmr.ms != null ? ` in ${lastHmr.ms} ms` : ""}.`));
  return out;
}

function hintText(hint) {
  if (!hint) return null;
  if (hint.kind === "could-be-live") return h("span", { class: "chip warn", title: `uses ${hint.uses.join(", ")}: with \`export const live\` it would ship no JS (each event becomes a server round trip)` }, "could be live");
  return h("span", { class: "chip warn", title: "no state or event handlers: a plain component (outside islands/) would ship no JS" }, "needs no JS");
}

function islandsPanel(page) {
  const known = new Map((page.islands || []).map((i) => [i.name, i]));
  const screen = onScreenIslands();
  const out = [sec(`On this page (${screen.length})`)];
  if (!screen.length) out.push(h("div", { class: "muted" }, "No islands rendered."));
  const items = screen.map((i) => {
    const info = known.get(i.name);
    return h(
      "li",
      { "data-island": i.name, "data-kind": i.kind },
      h("div", {}, h("b", {}, i.name), " ", h("span", { class: `chip ${i.kind === "live" ? "live" : ""}` }, i.kind), " ", h("span", { class: `chip ${i.state === "hydrated" ? "ok" : ""}` }, i.state), i.strategy && i.strategy !== "load" ? h("span", { class: "chip" }, `client:${i.strategy}`) : null, hintText(info?.hint)),
      h("div", { class: "muted" }, info ? source(info.file) : null, info && i.kind === "client" ? ` · ~${kb(info.gzipBytes)} gzip` : info ? " · no client JS" : null),
    );
  });
  if (items.length) out.push(h("ul", {}, items));
  const unseen = [...known.values()].filter((i) => !screen.some((s) => s.name === i.name));
  if (unseen.length) {
    out.push(sec("Reachable from the route, not rendered now"));
    out.push(h("ul", {}, unseen.map((i) => h("li", { "data-island": i.name, "data-kind": i.kind }, h("b", {}, i.name), " ", h("span", { class: "chip" }, i.kind), hintText(i.hint), h("div", { class: "muted" }, source(i.file))))));
  }
  return out;
}

function jsPanel(page) {
  const js = page.js;
  if (!js) return [h("div", { class: "muted" }, page.route ? `A ${page.route.kind} route ships no page JS.` : "No route.")];
  const est = js.estimate;
  const budget = js.budgetKB;
  const over = budget != null && est.gzipBytes / 1024 > budget;
  const out = [
    h(
      "div",
      { "data-budget": "", class: "row" },
      h("div", { class: "k" }, "first-load JS"),
      h("div", { class: "v" }, h("b", {}, kb(est.gzipBytes)), " gzip ", h("span", { class: "chip" }, est.label), budget != null ? h("span", { class: `chip ${over ? "bad" : "ok"}` }, `${over ? "over" : "within"} budget ${budget} KB`) : h("span", { class: "muted" }, md(" no `export const budget`"))),
    ),
  ];
  if (budget != null) {
    const fill = h("div", { class: `fill ${over ? "over" : ""}` });
    fill.style.width = `${Math.min(100, (est.gzipBytes / 1024 / budget) * 100)}%`;
    out.push(h("div", { class: "bar", role: "img", "aria-label": `${kb(est.gzipBytes)} of ${budget} KB` }, fill));
  }
  out.push(
    h(
      "table",
      {},
      est.runtime != null ? h("tr", {}, h("td", {}, "islands runtime + Preact"), h("td", { class: "n" }, kb(est.runtime))) : null,
      h("tr", {}, h("td", {}, "client islands"), h("td", { class: "n" }, kb(est.islands))),
      est.liveRuntime != null ? h("tr", {}, h("td", {}, "live runtime"), h("td", { class: "n" }, kb(est.liveRuntime))) : null,
    ),
  );
  const lb = js.lastBuild;
  out.push(row("last build", lb ? [h("b", { "data-last-build": "" }, kb(lb.gzipBytes)), h("span", { class: "muted" }, lb.builtAt ? ` (dist/, ${new Date(lb.builtAt).toLocaleString()})` : " (dist/)")] : h("span", { class: "muted" }, md("no `nowaki build` output in dist/"))));
  out.push(h("div", { class: "note" }, md("Estimate: the dev transform of the route's island graph and the runtime, minified and gzipped. `nowaki build` splits and hoists modules, so its figure differs a little; the build checks the budget.")));
  return out;
}

function isrPanel(page) {
  const r = page.route;
  const out = [];
  if (!r || r.kind !== "page") return [h("div", { class: "muted" }, "Not a page route.")];
  out.push(row("revalidate", r.revalidate !== undefined ? h("span", { "data-revalidate": "" }, r.revalidate === false ? "false (cached until revalidated)" : `${r.revalidate} s`) : h("span", { class: "muted" }, "none: rendered for every request")));
  if (r.tags !== undefined) out.push(row("tags", r.tags === "function" ? h("span", { class: "muted" }, "computed per request (a function)") : r.tags.map((t) => h("span", { class: "chip" }, t))));
  if (r.revalidate !== undefined) out.push(h("div", { class: "note" }, md("Cached under `nowaki start` (and CDN-cached on Vercel). `nowaki dev` renders every request, so edits show at once.")));
  const tags = Array.isArray(r.tags) ? r.tags : [];
  const path = page.path?.split("?")[0];
  const recent = (page.revalidations || []).slice().reverse();
  out.push(sec(`Recent revalidations (${recent.length})`));
  if (!recent.length) out.push(h("div", { class: "muted" }, "No revalidatePath / revalidateTag calls yet."));
  else
    out.push(
      h(
        "ul",
        {},
        recent.slice(0, 10).map((c) => {
          const hit = (c.entries || []).some((e) => e === `p:${path}` || tags.some((t) => e === `t:${t}`));
          return h("li", {}, h("code", {}, c.call), hit ? h("span", { class: "chip live" }, " this page") : null, h("div", { class: "muted" }, new Date(c.at).toLocaleTimeString()));
        }),
      ),
    );
  return out;
}

function livePanel() {
  const live = data.live || { connections: 0, rooms: [] };
  const onPage = document.querySelectorAll("nowaki-live").length;
  const out = [
    row("connections", h("b", { "data-live-connections": "" }, live.connections), live.max ? h("span", { class: "muted" }, ` of ${live.max} (NOWAKI_LIVE_MAX)`) : null),
    row("on this page", `${onPage} live island${onPage === 1 ? "" : "s"}`),
    sec(`Rooms (${live.rooms.length})`),
  ];
  if (!live.rooms.length) out.push(h("div", { class: "muted" }, "No rooms in use."));
  else out.push(h("table", {}, live.rooms.map((r) => h("tr", {}, h("td", {}, h("code", {}, r.room)), h("td", { class: "n" }, `${r.connections} connection${r.connections === 1 ? "" : "s"}`)))));
  return out;
}

function errorsPanel() {
  const list = data.errors?.errors || [];
  if (!list.length) return [h("div", { class: "muted" }, "No errors recorded.")];
  return [
    h(
      "ul",
      {},
      list.map((e) =>
        h(
          "li",
          { "data-error": e.source },
          h("div", {}, h("span", { class: "chip bad" }, e.source), " ", h("span", { class: "muted" }, new Date(e.time).toLocaleTimeString()), e.path ? h("span", { class: "muted" }, ` ${e.path}`) : null),
          h("div", {}, String(e.message).split("\n")[0].slice(0, 300)),
          e.file ? h("div", {}, source(e.file)) : null,
          e.stack || String(e.message).includes("\n") ? h("details", {}, h("summary", { class: "muted" }, "details"), h("pre", { class: "mono" }, e.stack || e.message)) : null,
        ),
      ),
    ),
  ];
}

if (ui.open) setOpen(true);
render();
refresh();
