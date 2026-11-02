// Jetstream client runtime. Sends data-live events over WS and morphs in the returned HTML patches.
// If the WS can't connect or drops, the initial SSR stays intact (graceful degradation only).

function lives() {
  return [...document.querySelectorAll("nowaki-live")];
}

function connect() {
  const els = lives();
  if (!els.length) return;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws;
  let retry = 0;

  const open = () => {
    ws = new WebSocket(`${proto}://${location.host}/__nowaki/live`);
    ws.onopen = () => {
      retry = 0;
      ws.send(
        JSON.stringify({
          type: "join",
          islands: lives().map((el) => ({
            nid: el.getAttribute("nid"),
            name: el.getAttribute("name"),
            state: parse(el.getAttribute("state")),
            sig: el.getAttribute("sig"),
          })),
        }),
      );
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "patch") {
        const el = document.querySelector(`nowaki-live[nid="${cssEscape(msg.nid)}"]`);
        if (el) morph(el, msg.html);
      } else if (msg.type === "presence") {
        for (const el of document.querySelectorAll("[data-nowaki-presence]")) {
          el.textContent = String(msg.count);
        }
        window.dispatchEvent(new CustomEvent("nowaki:presence", { detail: { count: msg.count } }));
      } else if (msg.type === "error" && msg.reason === "at capacity") {
        // Limit reached: the server closed the connection. Degrade to the initial SSR (still tries to reconnect).
        console.warn("[nowaki live] server at capacity; staying on the initial SSR view");
      }
    };
    // Reconnect (exponential backoff, capped). Re-joining restores state.
    ws.onclose = () => {
      const delay = Math.min(1000 * 2 ** retry++, 10000);
      setTimeout(open, delay);
    };
    ws.onerror = () => ws.close();
  };
  open();

  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-live]");
    if (!t) return;
    const host = t.closest("nowaki-live");
    if (!host || !ws || ws.readyState !== 1) return;
    ev.preventDefault();
    ws.send(
      JSON.stringify({
        type: "event",
        nid: host.getAttribute("nid"),
        handler: t.getAttribute("data-live"),
        payload: t.value !== undefined ? t.value : undefined,
      }),
    );
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

// Minimal DOM morph (keyless, in-place updates).
function morph(from, toHtml) {
  const tmp = document.createElement("template");
  tmp.innerHTML = toHtml;
  morphChildren(from, tmp.content);
}

function morphChildren(from, to) {
  const fromNodes = from.childNodes;
  const toNodes = to.childNodes;
  let i = 0;
  for (; i < toNodes.length; i++) {
    const tn = toNodes[i];
    const fn = fromNodes[i];
    if (!fn) {
      from.appendChild(tn.cloneNode(true));
      continue;
    }
    if (fn.nodeType !== tn.nodeType || (fn.nodeType === 1 && fn.tagName !== tn.tagName)) {
      from.replaceChild(tn.cloneNode(true), fn);
      continue;
    }
    if (fn.nodeType === 3) {
      if (fn.nodeValue !== tn.nodeValue) fn.nodeValue = tn.nodeValue;
    } else if (fn.nodeType === 1) {
      morphAttrs(fn, tn);
      morphChildren(fn, tn);
    }
  }
  while (fromNodes.length > toNodes.length) {
    from.removeChild(from.lastChild);
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
  // also sync the value property (value only, so focus/input aren't disrupted)
  if ("value" in from && to.hasAttribute("value")) {
    const v = to.getAttribute("value");
    if (from.value !== v) from.value = v;
  }
}

connect();
