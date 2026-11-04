// Jetstream WS e2e (join/presence/event->patch/disconnect). Uses Node 22+'s global WebSocket.
// Usage: node scripts/livetest.mjs <baseUrl>   e.g. node scripts/livetest.mjs http://127.0.0.1:3300

const base = process.argv[2] ?? "http://127.0.0.1:3300";
const wsUrl = base.replace(/^http/, "ws") + "/__nowaki/live";

// sig is an HMAC signature the server verifies on join (rejected without it). Extracted regardless of attribute order.
const html = await (await fetch(base + "/live")).text();
const tag = html.match(/<nowaki-live\b[^>]*>/)?.[0];
if (!tag || !/name="LiveCounter"/.test(tag)) {
  console.error("FAIL: <nowaki-live name=LiveCounter> not found on /live");
  process.exit(1);
}
const attr = (n) => tag.match(new RegExp(`${n}="([^"]*)"`))?.[1];
const nid = attr("nid");
const state = JSON.parse((attr("state") ?? "{}").replace(/&quot;/g, '"'));
const sig = attr("sig") ?? "";
console.log(`live island nid=${nid} state=${JSON.stringify(state)} sig=${sig.slice(0, 8)}…`);

const recvUntil = (ws, pred, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeout);
    const on = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (pred(msg)) {
        clearTimeout(t);
        ws.removeEventListener("message", on);
        resolve(msg);
      }
    };
    ws.addEventListener("message", on);
  });

const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });

let failed = false;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failed = true;
};

// Against a server started with a short NOWAKI_LIVE_RENDER_TIMEOUT_MS: a render past it is
// reported as an error, the state is unchanged, and the connection keeps working.
if (process.argv[3] === "--expect-timeout") {
  const t = await open(wsUrl);
  await recvUntil(t, (m) => m.type === "presence");
  t.send(JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state, sig }] }));
  t.send(JSON.stringify({ type: "event", nid, handler: "slow" }));
  const err = await recvUntil(t, (m) => m.type === "error" && m.nid === nid);
  check(err.reason === "timeout", `slow render reported as a timeout (reason=${err.reason})`);
  t.send(JSON.stringify({ type: "event", nid, handler: "inc" }));
  const after = await recvUntil(t, (m) => m.type === "patch" && m.nid === nid);
  check(/live:\s*1/.test(after.html), `next event still applies after a timeout (html has "live: 1")`);
  t.close();
  console.log(failed ? "\nLIVETEST (timeout) FAILED" : "\nLIVETEST (timeout) PASSED");
  process.exit(failed ? 1 : 0);
}

const a = await open(wsUrl);
const p1 = await recvUntil(a, (m) => m.type === "presence");
check(p1.count >= 1, `presence after first connect (count=${p1.count})`);

a.send(JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state, sig }] }));

a.send(JSON.stringify({ type: "event", nid, handler: "inc" }));
const patch = await recvUntil(a, (m) => m.type === "patch" && m.nid === nid);
check(/live:\s*1/.test(patch.html), `patch reflects incremented count (html has "live: 1")`);

// Listen before b connects: the broadcast can reach a before b's open event resolves.
const p2Wait = recvUntil(a, (m) => m.type === "presence" && m.count >= 2);
const b = await open(wsUrl);
const p2 = await p2Wait;
check(p2.count >= 2, `presence rises on second connect (count=${p2.count})`);

b.close();
const p3 = await recvUntil(a, (m) => m.type === "presence" && m.count < p2.count);
check(p3.count < p2.count, `presence falls after disconnect (count=${p3.count})`);

a.close();

// Reconnect: re-joining with the state/sig from the last patch must resume (count 1 → 2), not reset to the SSR state.
check(patch.state !== undefined && typeof patch.sig === "string", "patch carries the signed state");
const c = await open(wsUrl);
c.send(JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state: patch.state, sig: patch.sig }] }));
c.send(JSON.stringify({ type: "event", nid, handler: "inc" }));
const resumed = await recvUntil(c, (m) => m.type === "patch" && m.nid === nid);
check(/live:\s*2/.test(resumed.html), `state survives a reconnect (html has "live: 2")`);
c.close();

// A slow render runs off the session loop: presence from a new connection is delivered before the
// slow event's patch, and an event sent after it is still applied after it (live: 3).
const d = await open(wsUrl);
await recvUntil(d, (m) => m.type === "presence");
d.send(JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state: resumed.state, sig: resumed.sig }] }));
const seen = [];
d.addEventListener("message", (e) => {
  try {
    const m = JSON.parse(e.data);
    if (m.type === "presence" || m.type === "patch") seen.push(m);
  } catch {}
});
d.send(JSON.stringify({ type: "event", nid, handler: "slow" }));
d.send(JSON.stringify({ type: "event", nid, handler: "inc" }));
const e = await open(wsUrl);
const last = await recvUntil(d, (m) => m.type === "patch" && /live:\s*3/.test(m.html));
const firstPresence = seen.findIndex((m) => m.type === "presence");
const firstPatch = seen.findIndex((m) => m.type === "patch");
check(firstPresence !== -1 && firstPresence < firstPatch, "presence arrives while a slow render is in flight");
check(seen.filter((m) => m.type === "patch").length === 2 && Boolean(last), "events after a slow one apply in order (live: 3)");
d.close();
e.close();

// Request context: handlers see the upgrade request's cookies via getContext(), and
// `live.authorize` refuses adminReset unless the role cookie is admin.
const withCookie = (cookie) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });
const u = await withCookie("user=alice");
await recvUntil(u, (m) => m.type === "presence");
u.send(JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state, sig }] }));
u.send(JSON.stringify({ type: "event", nid, handler: "greet" }));
const greeted = await recvUntil(u, (m) => m.type === "patch" && m.nid === nid);
check(/hi\s*alice/.test(greeted.html), "handler reads the cookie through getContext() (hi alice)");
u.send(JSON.stringify({ type: "event", nid, handler: "adminReset" }));
const denied = await recvUntil(u, (m) => m.type === "error" && m.nid === nid);
check(denied.reason === "forbidden", `live.authorize refuses adminReset without the role (reason=${denied.reason})`);
u.close();
const admin = await withCookie("role=admin");
await recvUntil(admin, (m) => m.type === "presence");
admin.send(JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state: greeted.state, sig: greeted.sig }] }));
admin.send(JSON.stringify({ type: "event", nid, handler: "adminReset" }));
const reset = await recvUntil(admin, (m) => m.type === "patch" && m.nid === nid);
check(/live:\s*0/.test(reset.html), "live.authorize allows adminReset with role=admin (live: 0)");
admin.close();

// Live query: LiveTicks subscribes to "ticks"; POST /api/tick calls publish("ticks"), and the
// server pushes a fresh patch to the subscribed island without any client event.
{
  const page = await (await fetch(base + "/live")).text();
  const ttag = page.match(/<nowaki-live\b[^>]*name="LiveTicks"[^>]*>/)?.[0] ?? page.match(/<nowaki-live\b(?=[^>]*name="LiveTicks")[^>]*>/)?.[0];
  const tattr = (n) => ttag?.match(new RegExp(`${n}="([^"]*)"`))?.[1];
  check(Boolean(ttag) && /ticks/.test(tattr("topics")?.replace(/&quot;/g, '"') ?? ""), "LiveTicks is rendered with its topics");
  const tnid = tattr("nid");
  const tstate = JSON.parse((tattr("state") ?? "{}").replace(/&quot;/g, '"'));
  const topics = JSON.parse((tattr("topics") ?? "[]").replace(/&quot;/g, '"'));
  const q = await open(wsUrl);
  await recvUntil(q, (m) => m.type === "presence");
  q.send(JSON.stringify({ type: "join", islands: [{ nid: tnid, name: "LiveTicks", state: tstate, sig: tattr("sig"), topics }] }));
  await new Promise((r) => setTimeout(r, 100)); // let the join land before publishing
  const pushed = recvUntil(q, (m) => m.type === "patch" && m.nid === tnid);
  const r = await (await fetch(base + "/api/tick", { method: "POST" })).json();
  const patch = await pushed;
  check(new RegExp(`ticks:\\s*${r.ticks}`).test(patch.html), `publish("ticks") pushes a patch (ticks: ${r.ticks})`);
  q.close();
}

// Rooms: two connections on /poll share one state; a vote on one is pushed to the other.
{
  const page = await (await fetch(base + "/poll")).text();
  const ptag = page.match(/<nowaki-live\b(?=[^>]*name="LivePoll")[^>]*>/)?.[0];
  const pattr = (n) => ptag?.match(new RegExp(`${n}="([^"]*)"`))?.[1];
  const pstate = JSON.parse((pattr("state") ?? "{}").replace(/&quot;/g, '"'));
  const ptopics = JSON.parse((pattr("topics") ?? "[]").replace(/&quot;/g, '"'));
  check(pstate.room === "poll:demo" && ptopics.includes("room:poll:demo"), "LivePoll's signed state names its room");
  const votes = (html) => /a:\s*(\d+)\s*·\s*b:\s*(\d+)/.exec(html)?.slice(1).map(Number);
  const before = votes(page) ?? [0, 0];
  const joinPoll = async () => {
    const ws = await open(wsUrl);
    await recvUntil(ws, (m) => m.type === "presence");
    ws.send(JSON.stringify({ type: "join", islands: [{ nid: pattr("nid"), name: "LivePoll", state: pstate, sig: pattr("sig"), topics: ptopics }] }));
    return ws;
  };
  const tabA = await joinPoll();
  const roomOfTwo = recvUntil(tabA, (m) => m.type === "presence" && m.room === "poll:demo" && m.count >= 2);
  const tabB = await joinPoll();
  const rp = await roomOfTwo;
  check(rp.count === 2, `room presence counts both tabs (room=${rp.room}, count=${rp.count})`);
  await new Promise((r) => setTimeout(r, 100));
  const pushedToB = recvUntil(tabB, (m) => m.type === "patch" && m.nid === pattr("nid"));
  tabA.send(JSON.stringify({ type: "event", nid: pattr("nid"), handler: "vote", payload: "a" }));
  const onA = await recvUntil(tabA, (m) => m.type === "patch" && m.nid === pattr("nid"));
  const onB = await pushedToB;
  check(votes(onA.html)?.[0] === before[0] + 1, `the voter sees its vote (a: ${votes(onA.html)?.[0]})`);
  check(votes(onB.html)?.[0] === before[0] + 1, `the other tab gets the room's new state pushed (a: ${votes(onB.html)?.[0]})`);
  // A forged room in the signed state is rejected (no patch, an error instead).
  tabB.send(JSON.stringify({ type: "join", islands: [{ nid: "X1", name: "LivePoll", state: { room: "poll:secret" }, sig: pattr("sig"), topics: ["room:poll:secret"] }] }));
  tabB.send(JSON.stringify({ type: "event", nid: "X1", handler: "vote", payload: "a" }));
  const forged = await recvUntil(tabB, (m) => m.nid === "X1");
  check(forged.type === "error", `a forged room is refused (${forged.type})`);
  const roomOfOne = recvUntil(tabA, (m) => m.type === "presence" && m.room === "poll:demo" && m.count === 1);
  tabB.close();
  check((await roomOfOne).count === 1, "room presence drops when a tab leaves");
  tabA.close();
}

console.log(failed ? "\nLIVETEST FAILED" : "\nLIVETEST PASSED");
process.exit(failed ? 1 : 0);
