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
console.log(failed ? "\nLIVETEST FAILED" : "\nLIVETEST PASSED");
process.exit(failed ? 1 : 0);
