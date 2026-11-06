// Jetstream client runtime. Sends data-live events and morphs in the returned HTML patches, over the
// /__nowaki/live WebSocket or, per event, POST /__nowaki/live-event. Transport: the app's
// <meta name="nowaki-live" content="ws|post"> wins; then the server's data-live-transport on this
// script (adapters without a WS endpoint say "post"); otherwise WS, with POST for any event sent
// while the socket isn't open. If nothing works, the initial SSR stays intact.

const MAX_RETRIES = 8;

const mode =
  document.querySelector('meta[name="nowaki-live"]')?.content ||
  document.querySelector("script[data-live-transport]")?.dataset.liveTransport ||
  "auto";

function lives() {
  return [...document.querySelectorAll("nowaki-live")];
}

// `replace`: these are all the islands on the page now, so the server drops any others it holds
// (the previous page's, after a client navigation). A join that only hands over new state doesn't.
const joinMsg = (els, replace = false) =>
  JSON.stringify({
    type: "join",
    ...(replace ? { replace: true } : {}),
    islands: els.map((el) => ({
      nid: el.getAttribute("nid"),
      name: el.getAttribute("name"),
      state: parse(el.getAttribute("state")),
      sig: el.getAttribute("sig"),
      topics: parse(el.getAttribute("topics")),
    })),
  });

function apply(el, msg) {
  morph(el, msg.html);
  // A re-join after a reconnect (and the next POST) sends these, so the server resumes instead of resetting.
  if (msg.state !== undefined && msg.sig) {
    el.setAttribute("state", JSON.stringify(msg.state));
    el.setAttribute("sig", msg.sig);
  }
}

let reloading = false;

function failed(nid, reason) {
  // The event was not applied (render timeout / failure / queue full); the island keeps its last HTML.
  console.warn(`[nowaki live] event on ${nid} not applied: ${reason}`);
  window.dispatchEvent(new CustomEvent("nowaki:live-error", { detail: { nid, reason } }));
  // The page outlived its signed state (NOWAKI_LIVE_MAX_AGE): reload for a fresh one, unless the
  // app calls preventDefault() on nowaki:live-stale (e.g. to save a draft first).
  if (reason === "stale" && !reloading) {
    const ev = new CustomEvent("nowaki:live-stale", { cancelable: true, detail: { nid } });
    if (window.dispatchEvent(ev)) {
      reloading = true;
      location.reload();
    }
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws = null;
  let retry = 0;
  let timer = null; // pending reconnect
  // One POST at a time, so each event starts from the state the previous one returned.
  let chain = Promise.resolve();

  const open = () => {
    timer = null;
    const sock = new WebSocket(`${proto}://${location.host}/__nowaki/live`);
    ws = sock;
    sock.onopen = () => {
      if (sock !== ws) return;
      retry = 0;
      sock.send(joinMsg(lives(), true));
    };
    sock.onmessage = (e) => {
      if (sock !== ws) return; // a socket closed by a client navigation
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "patch") {
        const el = document.querySelector(`nowaki-live[nid="${cssEscape(msg.nid)}"]`);
        if (el) apply(el, msg);
      } else if (msg.type === "presence") {
        // data-nowaki-presence="" shows everyone connected; ="<room>" shows that room (live.room).
        const want = typeof msg.room === "string" ? msg.room : "";
        for (const el of document.querySelectorAll("[data-nowaki-presence]")) {
          if (el.getAttribute("data-nowaki-presence") === want) el.textContent = String(msg.count);
        }
        window.dispatchEvent(new CustomEvent("nowaki:presence", { detail: { count: msg.count, room: msg.room } }));
      } else if (msg.type === "error" && msg.reason === "at capacity") {
        // Limit reached: the server closed the connection. Degrade to the initial SSR (still tries to reconnect).
        console.warn("[nowaki live] server at capacity; staying on the initial SSR view");
      } else if (msg.type === "error" && msg.nid) {
        failed(msg.nid, msg.reason);
      }
    };
    // Reconnect (exponential backoff, capped). Re-joining restores state. Give up after
    // MAX_RETRIES failures in a row (~1 min) so a host without a live endpoint isn't hammered.
    sock.onclose = () => {
      if (sock !== ws) return;
      ws = null;
      if (retry >= MAX_RETRIES) return;
      const delay = Math.min(1000 * 2 ** retry++, 10000);
      timer = setTimeout(open, delay);
    };
    sock.onerror = () => sock.close();
  };

  // Match the socket to the islands on the page: at startup, and after each client navigation
  // (the router swaps <body> and fires nowaki:page-load). The new page's islands replace the old
  // ones on the open socket; a page without any closes it, so the server forgets the old islands
  // and their rooms.
  const sync = () => {
    if (mode === "post") return;
    const els = lives();
    if (!els.length) {
      clearTimeout(timer);
      timer = null;
      const sock = ws;
      ws = null;
      sock?.close();
      return;
    }
    if (ws?.readyState === 1) ws.send(joinMsg(els, true));
    else if (!ws && !timer) {
      retry = 0; // also after giving up: a navigation is a fresh start
      open();
    }
    // Otherwise the socket is connecting or a reconnect is pending: its onopen joins these.
  };
  sync();
  document.addEventListener("nowaki:page-load", sync);

  const post = (el, handler, payload) => {
    chain = chain.then(async () => {
      try {
        const r = await fetch("/__nowaki/live-event", {
          method: "POST",
          headers: { "content-type": "application/json", "x-nowaki-live": "1" },
          body: JSON.stringify({
            name: el.getAttribute("name"),
            state: parse(el.getAttribute("state")),
            sig: el.getAttribute("sig"),
            handler,
            payload,
          }),
        });
        if (r.status === 409) return failed(el.getAttribute("nid"), "stale");
        const msg = r.ok ? await r.json() : null;
        if (typeof msg?.html !== "string") throw 0;
        apply(el, msg);
        // A socket that (re)connected meanwhile holds the older state: hand it the new one.
        if (ws?.readyState === 1) ws.send(joinMsg([el]));
      } catch {
        failed(el.getAttribute("nid"), "render failed");
      }
    });
  };

  // One path for every event kind: the open socket, else POST (unless the page pinned "ws").
  const send = (host, handler, payload) => {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: "event", nid: host.getAttribute("nid"), handler, payload }));
    } else if (mode !== "ws") {
      post(host, handler, payload);
    } else {
      return false;
    }
    return true;
  };
  // Checkboxes and radios send which one and whether it's on; other fields send their value.
  const valueOf = (el) =>
    el.type === "checkbox" || el.type === "radio" ? { value: el.value, checked: el.checked } : el.value;
  const timers = new WeakMap();

  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-live]");
    const host = t?.closest("nowaki-live");
    if (!host) return;
    if (send(host, t.getAttribute("data-live"), t.value !== undefined ? t.value : undefined)) ev.preventDefault();
  });

  // <form data-live-submit="handler">: the form's fields as an object, no page navigation.
  document.addEventListener("submit", (ev) => {
    const form = ev.target.closest?.("form[data-live-submit]");
    const host = form?.closest("nowaki-live");
    if (!host) return;
    const data = Object.fromEntries(new FormData(form, ev.submitter));
    if (send(host, form.getAttribute("data-live-submit"), data)) ev.preventDefault();
  });

  // data-live-input fires while typing (debounced by data-live-debounce ms, default 150);
  // data-live-change fires on commit (blur, select, checkbox).
  document.addEventListener("input", (ev) => {
    const el = ev.target.closest?.("[data-live-input]");
    const host = el?.closest("nowaki-live");
    if (!host) return;
    clearTimeout(timers.get(el));
    const ms = Number(el.getAttribute("data-live-debounce") ?? 150);
    timers.set(el, setTimeout(() => send(host, el.getAttribute("data-live-input"), valueOf(el)), ms));
  });
  document.addEventListener("change", (ev) => {
    const el = ev.target.closest?.("[data-live-change]");
    const host = el?.closest("nowaki-live");
    if (host) send(host, el.getAttribute("data-live-change"), valueOf(el));
  });
}

function parse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function cssEscape(s) {
  return CSS.escape(String(s));
}

// Minimal DOM morph. Children with data-key are matched by key (so reorders and inserts keep
// each element and its focus); the rest are matched by position.
function morph(from, toHtml) {
  const tmp = document.createElement("template");
  tmp.innerHTML = toHtml;
  morphChildren(from, tmp.content);
}

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute("data-key") : null);

function morphChildren(from, to) {
  const keyed = new Map();
  for (const n of from.childNodes) {
    const k = keyOf(n);
    if (k !== null) keyed.set(k, n);
  }
  let cur = from.firstChild;
  for (const tn of [...to.childNodes]) {
    const k = keyOf(tn);
    let fn = k !== null ? keyed.get(k) : cur && keyOf(cur) === null ? cur : null;
    if (k !== null) keyed.delete(k);
    if (fn && (fn.nodeType !== tn.nodeType || (fn.nodeType === 1 && fn.tagName !== tn.tagName))) fn = null;
    if (!fn) {
      from.insertBefore(tn.cloneNode(true), cur);
      continue;
    }
    if (fn !== cur) from.insertBefore(fn, cur);
    else cur = cur.nextSibling;
    if (fn.nodeType === 3 || fn.nodeType === 8) {
      if (fn.nodeValue !== tn.nodeValue) fn.nodeValue = tn.nodeValue;
    } else if (fn.nodeType === 1) {
      morphAttrs(fn, tn);
      morphChildren(fn, tn);
    }
  }
  // Whatever wasn't matched is gone from the new HTML.
  while (cur) {
    const next = cur.nextSibling;
    from.removeChild(cur);
    cur = next;
  }
}

function morphAttrs(from, to) {
  const fa = from.attributes;
  for (let i = fa.length - 1; i >= 0; i--) {
    if (!to.hasAttribute(fa[i].name)) from.removeAttribute(fa[i].name);
  }
  for (const a of to.attributes) {
    if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  }
  // Sync the live value/checked properties, but never under the user's cursor: a patch for an
  // earlier keystroke must not overwrite what they've typed since.
  if (from === document.activeElement) return;
  if ("value" in from && to.hasAttribute("value")) {
    const v = to.getAttribute("value");
    if (from.value !== v) from.value = v;
  }
  if (from.type === "checkbox" || from.type === "radio") from.checked = to.hasAttribute("checked");
}

connect();
