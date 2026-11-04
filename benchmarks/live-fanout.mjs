// Jetstream fan-out latency: N WebSocket connections subscribed to the same thing, one change on
// the server, time until every connection has its patch. Uses Node 22+'s global WebSocket.
//
// Usage: node benchmarks/live-fanout.mjs <baseUrl> [--conns 1000] [--rounds 50] [--scenario ticks|poll|both] [--out file.jsonl]
//   baseUrl  a `nowaki start` of examples/hello, e.g. http://127.0.0.1:8250
// Raise the file-descriptor limit first (macOS defaults to 256): `ulimit -n 8192` in the shell
// that starts the server and in the one that runs this script.
//
// Scenarios:
//   ticks  live query: every connection joins LiveTicks (/live, `live.subscribe: ["ticks"]`);
//          one POST /api/tick (which calls publish("ticks")) → each connection's first patch
//   poll   rooms: every connection joins LivePoll (/poll, room poll:demo); connection 0 votes
//          → the first patch on each of the other N - 1 connections
// Per round, t0 is taken just before the change is sent (the POST, or the vote frame). Reported:
//   delivery  latency of every single delivery, all rounds pooled: p50 / p95 / p99 / max
//   fan-out   per round, the latency of the last delivery (everyone has it): p50 / p95 / max
//   missing   deliveries that did not arrive within 10 s
// Each round's patches must all carry the same new value, so a late patch from an earlier round
// cannot be counted. The first 3 rounds are a warm-up and are not reported. The receiving side is
// one Node process too: the time it takes to handle N messages is part of the numbers.

import { appendFileSync } from "node:fs";
import os from "node:os";

const base = process.argv[2];
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
if (!base || base.startsWith("--")) {
  console.error("usage: node benchmarks/live-fanout.mjs <baseUrl> [--conns 1000] [--rounds 50] [--scenario ticks|poll|both] [--out file.jsonl]");
  process.exit(2);
}
const N = Number(arg("conns", 1000));
const ROUNDS = Number(arg("rounds", 50));
const WARMUP = 3;
const scenarios = arg("scenario", "both") === "both" ? ["ticks", "poll"] : [arg("scenario")];
const out = arg("out", null);
const wsUrl = `${base.replace(/^http/, "ws")}/__nowaki/live`;
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unescape = (s) => (s ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function island(page, name) {
  const html = await (await fetch(base + page)).text();
  const tag = html.match(new RegExp(`<nowaki-live\\b(?=[^>]*name="${name}")[^>]*>`))?.[0];
  if (!tag) throw new Error(`no <nowaki-live name="${name}"> on ${page}`);
  const attr = (n) => tag.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
  return {
    nid: attr("nid"),
    name,
    state: JSON.parse(unescape(attr("state")) || "{}"),
    sig: attr("sig") ?? "",
    topics: JSON.parse(unescape(attr("topics")) || "[]"),
  };
}

const open = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

async function connectAll(join) {
  const conns = [];
  for (let i = 0; i < N; i += 100) {
    const batch = await Promise.allSettled(Array.from({ length: Math.min(100, N - i) }, open));
    for (const r of batch) if (r.status === "fulfilled") conns.push(r.value);
  }
  if (conns.length !== N) throw new Error(`opened ${conns.length}/${N} connections (raise ulimit -n?)`);
  for (const ws of conns) ws.send(JSON.stringify({ type: "join", islands: [join] }));
  await sleep(2000); // joins and presence broadcasts settle
  return conns;
}

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 100) / 100 : null;
};

async function run(scenario) {
  const join = scenario === "ticks" ? await island("/live", "LiveTicks") : await island("/poll", "LivePoll");
  // The value a patch carries: the tick count, or votes for "a".
  const value = scenario === "ticks" ? (h) => /ticks:\s*(\d+)/.exec(h)?.[1] : (h) => /a:\s*(\d+)/.exec(h)?.[1];
  const conns = await connectAll(join);
  const targets = scenario === "ticks" ? conns : conns.slice(1);

  let round = null; // { t0, got: Map<ws, {ms, value}>, done }
  for (const ws of targets) {
    ws.addEventListener("message", (e) => {
      if (!round || round.got.has(ws)) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type !== "patch" || msg.nid !== join.nid) return;
      const v = value(msg.html ?? "");
      if (v == null || Number(v) <= round.previous) return; // a stale patch from an earlier round
      round.got.set(ws, { ms: now() - round.t0, value: Number(v) });
      if (round.got.size === targets.length) round.done();
    });
  }

  const deliveries = [];
  const fanouts = [];
  let missing = 0;
  let previous = -1;
  for (let r = 0; r < WARMUP + ROUNDS; r++) {
    const finished = new Promise((resolve) => {
      round = { t0: 0, got: new Map(), previous, done: resolve };
    });
    round.t0 = now();
    if (scenario === "ticks") fetch(`${base}/api/tick`, { method: "POST" }).then((res) => res.body?.cancel());
    else conns[0].send(JSON.stringify({ type: "event", nid: join.nid, handler: "vote", payload: "a" }));
    await Promise.race([finished, sleep(10000)]);
    const got = [...round.got.values()];
    const values = new Set(got.map((g) => g.value));
    if (values.size > 1) throw new Error(`round ${r}: patches carried different values ${[...values]}`);
    previous = got[0]?.value ?? previous;
    if (r >= WARMUP) {
      for (const g of got) deliveries.push(g.ms);
      missing += targets.length - got.length;
      if (got.length) fanouts.push(Math.max(...got.map((g) => g.ms)));
    }
    round = null;
    await sleep(250);
  }
  for (const ws of conns) ws.close();
  await sleep(1000);

  const res = {
    scenario,
    conns: N,
    receivers: targets.length,
    rounds: ROUNDS,
    delivery: { p50: pct(deliveries, 0.5), p95: pct(deliveries, 0.95), p99: pct(deliveries, 0.99), max: pct(deliveries, 1) },
    fanout: { p50: pct(fanouts, 0.5), p95: pct(fanouts, 0.95), max: pct(fanouts, 1) },
    missing,
  };
  console.log(
    `${scenario}: ${N} conns, ${targets.length} receivers, ${ROUNDS} rounds · delivery p50 ${res.delivery.p50} / p95 ${res.delivery.p95} / p99 ${res.delivery.p99} / max ${res.delivery.max} ms · fan-out (last delivery) p50 ${res.fanout.p50} / p95 ${res.fanout.p95} / max ${res.fanout.max} ms · missing ${missing}`,
  );
  return res;
}

const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}, node ${process.version}`;
let failed = false;
for (const s of scenarios) {
  const res = await run(s);
  if (res.missing) failed = true;
  if (out) appendFileSync(out, `${JSON.stringify({ ...res, base, at: new Date().toISOString(), machine })}\n`);
}
process.exit(failed ? 1 : 0);
