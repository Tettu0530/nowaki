// Unit test for live-hub.mjs (the runtime-neutral Jetstream session) with a fake socket and render:
// join/event → patch, ordering, queue cap, timeout, connection cap, presence, message size, Origin.
// Usage: node scripts/live-hub-test.mjs
const { createLiveHub, liveOriginOk, MAX_QUEUED, MAX_MESSAGE_BYTES } = await import(
  "../packages/nowaki-runtime/server/live-hub.mjs"
);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeSocket() {
  const sock = {
    sent: [],
    closed: false,
    send(text) {
      sock.sent.push(JSON.parse(text));
    },
    close() {
      sock.closed = true;
    },
    of: (type) => sock.sent.filter((m) => m.type === type),
  };
  return sock;
}

// Counter render: `inc` adds one; the signature is just "sig:<count>" so tests can follow it.
function counterRender({ delay = () => 0 } = {}) {
  const calls = [];
  const render = async (name, state, sig, handler, payload) => {
    calls.push({ name, state, sig, handler, payload });
    const d = delay(calls.length);
    if (d) await tick(d);
    if (sig !== `sig:${state.count}`) return { error: "bad sig" };
    const next = handler === "inc" ? { count: state.count + 1 } : state;
    return { html: `<p>${next.count}</p>`, state: next, sig: `sig:${next.count}` };
  };
  return { render, calls };
}

const join = (count = 0, nid = "L0") =>
  JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state: { count }, sig: `sig:${count}` }] });
const event = (nid = "L0", handler = "inc") => JSON.stringify({ type: "event", nid, handler });

{
  const { render, calls } = counterRender();
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0));
  c.onText(event());
  await tick();
  const p = s.of("patch")[0];
  check("join + event → patch", p && p.nid === "L0" && p.html === "<p>1</p>" && p.state.count === 1 && p.sig === "sig:1");
  check("render gets name, state, sig, handler", calls[0]?.name === "LiveCounter" && calls[0]?.sig === "sig:0" && calls[0]?.handler === "inc");
  c.onText(event());
  await tick();
  check("next event uses the re-signed state", s.of("patch")[1]?.state.count === 2 && calls[1]?.sig === "sig:1");
  c.onText(event("L9"));
  c.onText("not json");
  c.onText(JSON.stringify({ type: "event", nid: "", handler: "inc" }));
  await tick();
  check("unknown nid / bad json ignored", calls.length === 2 && s.of("patch").length === 2 && s.of("error").length === 0);
  c.onClose();
}

{
  const { render } = counterRender();
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(JSON.stringify({ type: "join", islands: [{ nid: "L0", name: "LiveCounter", state: { count: 5 }, sig: "forged" }] }));
  c.onText(event());
  await tick();
  check("render without html → render failed, no patch", s.of("patch").length === 0 && s.of("error")[0]?.reason === "render failed");
  c.onClose();
}

{
  // The first render is slow; later events must wait and apply in order on the updated state.
  const { render, calls } = counterRender({ delay: (n) => (n === 1 ? 30 : 0) });
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0));
  c.onText(event());
  c.onText(event());
  c.onText(event());
  await tick(5);
  check("one render in flight per connection", calls.length === 1);
  await tick(60);
  const counts = s.of("patch").map((p) => p.state.count);
  check("ordered patches after a slow render", JSON.stringify(counts) === "[1,2,3]");
  c.onClose();
}

{
  let release;
  const gate = new Promise((r) => (release = r));
  const render = async (name, state, sig) => {
    await gate;
    return { html: "x", state, sig };
  };
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0));
  for (let i = 0; i < MAX_QUEUED + 2; i++) c.onText(event());
  const busy = s.of("error").filter((e) => e.reason === "busy");
  check(`queue holds ${MAX_QUEUED} behind the in-flight render, then busy`, busy.length === 1 && busy[0].nid === "L0");
  release();
  await tick(10);
  check("queued events all render", s.of("patch").length === MAX_QUEUED + 1);
  c.onClose();
}

{
  const render = () => new Promise(() => {});
  const hub = createLiveHub({ render, timeoutMs: 20 });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0));
  c.onText(event());
  await tick(50);
  const e = s.of("error")[0];
  check("render timeout → error", e?.nid === "L0" && e?.reason === "timeout" && s.of("patch").length === 0);
  c.onClose();
}

{
  const render = async () => {
    throw new Error("boom /secret/path");
  };
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0));
  c.onText(event());
  await tick();
  const e = s.of("error")[0];
  check("thrown render → generic render failed", e?.reason === "render failed" && !JSON.stringify(s.sent).includes("secret"));
  c.onClose();
}

{
  const { render } = counterRender();
  const hub = createLiveHub({ render, max: 2 });
  const a = fakeSocket();
  const b = fakeSocket();
  const ca = hub.open(a);
  check("presence on open", a.of("presence").at(-1)?.count === 1);
  const cb = hub.open(b);
  check("presence broadcast to everyone", a.of("presence").at(-1)?.count === 2 && b.of("presence").at(-1)?.count === 2);
  const x = fakeSocket();
  hub.open(x);
  check("over the cap → at capacity + close", x.sent[0]?.type === "error" && x.sent[0]?.reason === "at capacity" && x.closed);
  check("rejected socket isn't counted", hub.count === 2 && a.of("presence").at(-1)?.count === 2);
  cb.onClose();
  cb.onClose();
  check("presence on close (once)", hub.count === 1 && a.of("presence").at(-1)?.count === 1 && a.of("presence").length === 3);
  ca.onClose();
  check("count back to zero", hub.count === 0);
}

{
  const { render, calls } = counterRender();
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0));
  const pad = "x".repeat(MAX_MESSAGE_BYTES);
  c.onText(JSON.stringify({ type: "event", nid: "L0", handler: "inc", payload: pad }));
  c.onText(JSON.stringify({ type: "event", nid: "L0", handler: "inc", payload: "é".repeat(MAX_MESSAGE_BYTES / 2) }));
  await tick();
  check("oversized message dropped (bytes, not chars)", calls.length === 0 && s.sent.every((m) => m.type === "presence"));
  c.onText(event());
  await tick();
  check("normal message still works after a dropped one", s.of("patch").length === 1);
  c.onClose();
}

{
  let release;
  const render = (name, state, sig) => new Promise((r) => (release = () => r({ html: "x", state, sig })));
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0));
  c.onText(event());
  await tick();
  c.onClose();
  release();
  await tick();
  check("nothing sent after close", s.of("patch").length === 0 && s.of("error").length === 0);
}

{
  // The connection's request (from the transport) reaches render, and an authorize refusal is "forbidden".
  const seen = [];
  const render = async (name, state, sig, handler, payload, request) => {
    seen.push(request);
    if (handler === "adminReset") {
      const err = new Error("live event not authorized");
      err.name = "LiveForbiddenError";
      throw err;
    }
    return { html: "x", state, sig };
  };
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s, { headers: { cookie: "user=alice" } });
  c.onText(join(0));
  c.onText(event("L0", "noop"));
  c.onText(event("L0", "adminReset"));
  await tick();
  check("render gets the connection's request", seen[0]?.headers?.cookie === "user=alice");
  check("LiveForbiddenError → forbidden", s.of("error")[0]?.reason === "forbidden");
  c.onClose();
}

{
  // A client navigation sends a replacing join: the previous page's islands go, and a render of
  // one that was in flight is neither applied nor patched in.
  const { render } = counterRender({ delay: (n) => (n === 1 ? 30 : 0) });
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0, "L0"));
  c.onText(join(0, "L1"));
  c.onText(event("L0"));
  await tick(5);
  c.onText(JSON.stringify({ type: "join", replace: true, islands: [{ nid: "L2", name: "LiveCounter", state: { count: 7 }, sig: "sig:7" }] }));
  c.onText(event("L1"));
  await tick(50);
  check("replacing join: the old page's in-flight render isn't patched in", s.of("patch").length === 0 && s.of("error").length === 0);
  c.onText(event("L2"));
  await tick();
  check("replacing join: the new page's island works", s.of("patch").length === 1 && s.of("patch")[0].nid === "L2" && s.of("patch")[0].state.count === 8);
  c.onText(event("L0"));
  await tick();
  check("replacing join: the old islands are gone", s.of("patch").length === 1);
  c.onClose();
}

{
  // The same page again (Router Cache revisit: same nid, same island): the old page's queued
  // events are dropped and its in-flight render isn't patched in, so only the new page's run.
  const { render, calls } = counterRender({ delay: (n) => (n === 1 ? 30 : 0) });
  const hub = createLiveHub({ render });
  const s = fakeSocket();
  const c = hub.open(s);
  c.onText(join(0, "L0"));
  c.onText(event("L0"));
  c.onText(event("L0"));
  c.onText(event("L0"));
  await tick(5);
  c.onText(JSON.stringify({ type: "join", replace: true, islands: [{ nid: "L0", name: "LiveCounter", state: { count: 0 }, sig: "sig:0" }] }));
  await tick(50);
  check("replacing join (same nid): the old page's queued events don't run", calls.length === 1);
  check("replacing join (same nid): the old page's in-flight render isn't patched in", s.of("patch").length === 0 && s.of("error").length === 0);
  c.onText(event("L0"));
  await tick();
  check("replacing join (same nid): the new page's event starts from its own state", s.of("patch").length === 1 && s.of("patch")[0].state.count === 1);
  c.onClose();
}

check("origin: absent → allowed", liveOriginOk(undefined, "a.test") && liveOriginOk(null, null));
check("origin: same host → allowed", liveOriginOk("https://a.test", "a.test") && liveOriginOk("http://a.test:3000/", "a.test:3000"));
check("origin: other host → rejected", !liveOriginOk("https://evil.test", "a.test"));
check("origin: port mismatch → rejected", !liveOriginOk("http://a.test:4000", "a.test:3000"));
check("origin: no scheme / empty / null → rejected", !liveOriginOk("a.test", "a.test") && !liveOriginOk("", "") && !liveOriginOk("null", "a.test"));
check("origin: no host to compare → rejected", !liveOriginOk("https://a.test", undefined));

console.log(failures ? `\nLIVE HUB TEST FAILED (${failures})` : "\nLIVE HUB TEST PASSED");
process.exit(failures ? 1 : 0);
