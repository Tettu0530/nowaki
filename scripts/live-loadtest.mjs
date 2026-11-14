// Jetstream load test: opens N WebSocket connections to /__nowaki/live on a running examples/hello
// server, joins /live's LiveCounter on each, and reports (1) the time to open them, (2) the RSS
// growth of the given processes while connected (the resident cost per connection), and (3) event
// throughput (each connection sends `inc` and waits for its patch). Exits 1 unless every
// connection opens and gets its patch. Uses Node 22+'s global WebSocket. CI's jetstream-load job
// runs it with N=1000 against `nowaki start`.
// Usage: node scripts/live-loadtest.mjs <baseUrl> <N> <rustPid> <sidecarPid>
//   e.g. node scripts/live-loadtest.mjs http://127.0.0.1:8200 1000 12345 12346

import { execSync } from "node:child_process";

const base = process.argv[2];
const N = Number.parseInt(process.argv[3] ?? "1000", 10);
const pids = process.argv.slice(4).filter(Boolean);
const wsUrl = base.replace(/^http/, "ws") + "/__nowaki/live";
const now = () => Number(process.hrtime.bigint() / 1000000n);

const rssKB = () => {
  let total = 0;
  for (const p of pids) {
    try {
      total += Number.parseInt(execSync(`ps -o rss= -p ${p}`).toString().trim(), 10) || 0;
    } catch {}
  }
  return total;
};

// LiveCounter's nid, initial state and signature from /live, in any attribute order.
const html = await (await fetch(base + "/live")).text();
const tag = html.match(/<nowaki-live\b[^>]*>/)?.[0];
if (!tag || !/name="LiveCounter"/.test(tag)) {
  console.error("no <nowaki-live> on /live");
  process.exit(1);
}
const attr = (n) => tag.match(new RegExp(`${n}="([^"]*)"`))?.[1];
const nid = attr("nid");
const state = JSON.parse((attr("state") ?? "{}").replace(/&quot;/g, '"'));
const sig = attr("sig") ?? "";

const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

const baseRss = rssKB();
console.log(`baseline RSS: ${(baseRss / 1024).toFixed(1)} MB  (pids ${pids.join(",")})`);

// Connects in batches to limit file descriptor and accept peaks.
const t0 = now();
const conns = [];
const BATCH = 100;
for (let i = 0; i < N; i += BATCH) {
  const batch = await Promise.allSettled(
    Array.from({ length: Math.min(BATCH, N - i) }, () => open(wsUrl)),
  );
  for (const r of batch) if (r.status === "fulfilled") conns.push(r.value);
}
const connMs = now() - t0;
for (const ws of conns) {
  ws.send(JSON.stringify({ type: "join", islands: [{ nid, name: "LiveCounter", state, sig }] }));
}
await new Promise((r) => setTimeout(r, 1500)); // let presence broadcasts settle
const afterRss = rssKB();

console.log(`opened ${conns.length}/${N} connections in ${connMs} ms`);
console.log(
  `RSS after connect: ${(afterRss / 1024).toFixed(1)} MB  ` +
    `(+${((afterRss - baseRss) / 1024).toFixed(1)} MB, ~${(((afterRss - baseRss) * 1024) / conns.length / 1024).toFixed(1)} KB/conn)`,
);

let patches = 0;
for (const ws of conns) {
  ws.addEventListener("message", (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "patch") patches++;
  });
}
const te = now();
for (const ws of conns) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "event", nid, handler: "inc" }));
}
for (let i = 0; i < 200 && patches < conns.length; i++) await new Promise((r) => setTimeout(r, 100));
const evMs = now() - te;
console.log(
  `events: ${conns.length} inc sent → ${patches} patches in ${evMs} ms  ` +
    `(${Math.round((patches / evMs) * 1000)} renders/sec)`,
);

for (const ws of conns) ws.close();
// Every connection must open and get its patch back.
process.exit(conns.length === N && patches === N ? 0 : 1);
