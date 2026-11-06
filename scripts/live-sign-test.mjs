// Unit test for live-sign.mjs: signatures bind name, state, and issue time; expired, future-dated,
// legacy (unversioned), and tampered signatures are rejected.
// Usage: node scripts/live-sign-test.mjs
process.env.NOWAKI_LIVE_SECRET = "test-secret";
process.env.NOWAKI_LIVE_MAX_AGE = "3600";
const { sign, verify, verifyStatus } = await import("../packages/nowaki-runtime/server/live-sign.mjs");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

const now = 1_800_000_000;
const st = { count: 1, user: { id: 7, roles: ["a"] } };
const sig = sign("Counter", st, { now });
check("signature has the v1.<iat>.<mac> shape", /^v1\.1800000000\.[A-Za-z0-9_-]+$/.test(sig));
check("verifies with the same name and state", verify("Counter", st, sig, { now }));
check("key order doesn't matter", verify("Counter", { user: { roles: ["a"], id: 7 }, count: 1 }, sig, { now }));
check("rejects changed state", !verify("Counter", { ...st, count: 2 }, sig, { now }));
check("rejects another island name", !verify("Other", st, sig, { now }));
check("still valid just before max age", verify("Counter", st, sig, { now: now + 3600 }));
check("rejects after max age", !verify("Counter", st, sig, { now: now + 3601 }));
check("rejects a future-dated signature", !verify("Counter", st, sign("Counter", st, { now: now + 120 }), { now }));
check("rejects a changed issue time", !verify("Counter", st, sig.replace("v1.1800000000.", "v1.1800000500."), { now: now + 600 }));
check("rejects a legacy unversioned signature", !verify("Counter", st, sig.split(".")[2], { now }));
check("rejects empty and non-string", !verify("Counter", st, "", { now }) && !verify("Counter", st, undefined, { now }));

check("a fresh signature is ok", verifyStatus("Counter", st, sig, { now }) === "ok");
check("a genuine old signature is expired (not invalid)", verifyStatus("Counter", st, sig, { now: now + 3601 }) === "expired");
const forgedOld = `v1.${now - 99999}.${sig.split(".")[2]}`;
check("a forged signature with an old timestamp is invalid (never expired)", verifyStatus("Counter", st, forgedOld, { now }) === "invalid");
check("a future-dated signature is invalid", verifyStatus("Counter", st, sign("Counter", st, { now: now + 120 }), { now }) === "invalid");
check("tampered state is invalid even when old", verifyStatus("Counter", { count: 99 }, sig, { now: now + 3601 }) === "invalid");

// The state comes back as JSON (embedded in the page, held by Rust as serde_json, echoed by the client).
const roundTrip = (v) => JSON.parse(JSON.stringify(v));
for (const [label, state] of [
  ["an undefined-valued key", { count: 0, error: undefined }],
  ["a nested undefined-valued key", { user: { id: 1, nick: undefined }, list: [1, 2] }],
  ["a Date", { at: new Date(0) }],
  ["undefined inside an array", { list: [1, undefined, 3] }],
  ["a non-finite number", { n: NaN }],
]) {
  const s = sign("Counter", state, { now });
  check(`state with ${label} verifies after the JSON round trip`, verifyStatus("Counter", roundTrip(state), s, { now }) === "ok");
}
check("a round-tripped Date still differs from another value", !verify("Counter", { at: "x" }, sign("Counter", { at: new Date(0) }, { now }), { now }));

console.log(failures ? `\nLIVE SIGN TEST FAILED (${failures})` : "\nLIVE SIGN TEST PASSED");
process.exit(failures ? 1 : 0);
