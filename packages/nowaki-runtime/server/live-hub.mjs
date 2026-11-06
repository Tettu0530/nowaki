// Runtime-neutral Jetstream session hub: a port of crates/nowaki/src/live.rs with no I/O and no
// node: imports, so a JS server (Node, Bun, Deno, Workers) can terminate /__nowaki/live itself.
// The transport hands each socket to `hub.open` and feeds it text frames; heartbeats stay with it.
//
// `render(name, state, sig, handler, payload, request)` must verify `sig` before running any handler
// (liveRender does) and resolve to `{ html, state, sig }`; `request` is what the transport passed to
// `open` for this connection (the upgrade's headers, for getContext()). A LiveForbiddenError
// (live.authorize refused) is reported as "forbidden". The client only names islands it was
// served; the island module comes from the server's own registry, never from the message.

export const MAX_QUEUED = 32;
export const MAX_MESSAGE_BYTES = 64 * 1024;

const env = globalThis.process?.env ?? {};

function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/// Same rule as `prod_ws_origin_ok` in start.rs (CSWSH guard): no Origin (a non-browser client)
/// is allowed; otherwise the Origin's host must equal the host the browser addressed.
export function liveOriginOk(origin, host) {
  if (origin === undefined || origin === null) return true;
  const rest = String(origin).split("://")[1];
  if (rest === undefined) return false;
  if (host === undefined || host === null) return false;
  return rest.replace(/\/+$/, "") === host;
}

function byteLength(text) {
  // Every UTF-16 unit is at most 3 UTF-8 bytes, so most frames skip the encode.
  if (text.length * 3 <= MAX_MESSAGE_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

export function createLiveHub({
  render,
  max = positiveInt(env.NOWAKI_LIVE_MAX, 10_000),
  timeoutMs = positiveInt(env.NOWAKI_LIVE_RENDER_TIMEOUT_MS, 10_000),
} = {}) {
  if (typeof render !== "function") throw new Error("createLiveHub requires render");
  const conns = new Set();

  const send = (sock, msg) => {
    try {
      sock.send(JSON.stringify(msg));
    } catch {}
  };
  const presence = () => {
    for (const s of conns) send(s, { type: "presence", count: conns.size });
  };

  const renderWithTimeout = (name, state, sig, ev, request) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    const call = Promise.resolve().then(() => render(name, state, sig, ev.handler, ev.payload, request));
    return Promise.race([call, timeout]).then(
      (r) => {
        clearTimeout(timer);
        // No html (e.g. a failed signature check): never keep forged state or send an empty render.
        if (!r || typeof r.html !== "string") throw new Error("render failed");
        return r;
      },
      (err) => {
        clearTimeout(timer);
        throw err;
      },
    );
  };

  function open(sock, request = null) {
    if (conns.size >= max) {
      send(sock, { type: "error", reason: "at capacity" });
      try {
        sock.close();
      } catch {}
      return { onText() {}, onClose() {} };
    }
    conns.add(sock);
    presence();

    // nid -> { name, state, sig }
    const islands = new Map();
    const queue = [];
    let inflight = false;
    let closed = false;
    // Bumped by each replacing join (a client navigation): work queued or in flight for an
    // earlier page is dropped, even where the new page reuses its nids (as in live.rs).
    let page = 0;

    const pump = () => {
      while (!inflight && !closed && queue.length) {
        const ev = queue.shift();
        const isl = islands.get(ev.nid);
        if (!isl) continue;
        inflight = true;
        // A client navigation (a replacing join) may drop the island while it renders: then the
        // result or error is dropped too, as in live.rs (still_joined).
        const started = page;
        const gone = () => started !== page || islands.get(ev.nid)?.name !== isl.name;
        renderWithTimeout(isl.name, isl.state, isl.sig, ev, request).then(
          (r) => {
            inflight = false;
            if (closed) return;
            if (gone()) return pump();
            // Keep the new signature too so the next event can be verified.
            if (r.state !== undefined) islands.set(ev.nid, { name: isl.name, state: r.state, sig: r.sig ?? "" });
            const cur = islands.get(ev.nid);
            if (cur) send(sock, { type: "patch", page, nid: ev.nid, html: r.html, state: cur.state, sig: cur.sig });
            pump();
          },
          (err) => {
            inflight = false;
            if (closed) return;
            if (gone()) return pump();
            const reason =
              err?.message === "timeout"
                ? "timeout"
                : err?.name === "LiveForbiddenError"
                  ? "forbidden"
                  : err?.code === "NOWAKI_LIVE_STALE"
                    ? "stale"
                    : "render failed";
            console.error(`[nowaki live] ${isl.name} re-render ${reason}`);
            send(sock, { type: "error", page, nid: ev.nid, reason });
            pump();
          },
        );
      }
    };

    const onText = (text) => {
      if (closed || typeof text !== "string" || byteLength(text) > MAX_MESSAGE_BYTES) return;
      let v;
      try {
        v = JSON.parse(text);
      } catch {
        return;
      }
      if (v?.type === "join") {
        if (!Array.isArray(v.islands)) return;
        // `replace`: the client lists every island on its page (after a client navigation too).
        // The old page's queued events and refreshes go with it.
        if (v.replace === true) {
          islands.clear();
          queue.length = 0;
          page++;
        }
        for (const it of v.islands) {
          const nid = typeof it?.nid === "string" ? it.nid : "";
          if (!nid) continue;
          islands.set(nid, {
            name: typeof it.name === "string" ? it.name : "",
            state: it.state ?? {},
            // Signature of the initial state (issued at SSR); render verifies it before any handler.
            sig: typeof it.sig === "string" ? it.sig : "",
          });
        }
      } else if (v?.type === "event") {
        const nid = typeof v.nid === "string" ? v.nid : "";
        if (!islands.has(nid)) return;
        if (queue.length >= MAX_QUEUED) {
          send(sock, { type: "error", page, nid, reason: "busy" });
          return;
        }
        queue.push({ nid, handler: v.handler ?? null, payload: v.payload ?? null });
        pump();
      }
    };

    const onClose = () => {
      if (closed) return;
      closed = true;
      queue.length = 0;
      conns.delete(sock);
      presence();
    };

    return { onText, onClose };
  }

  return {
    open,
    get count() {
      return conns.size;
    },
  };
}
