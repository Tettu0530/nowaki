// Unit test for server/live-rooms-file.mjs: rooms written to disk come back after a restart.
// Usage: node scripts/live-rooms-file-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { exportRooms, importRooms } = await import("../packages/nowaki-runtime/server/live.mjs");
const { roomsFilePath, loadRooms, saveRooms } = await import("../packages/nowaki-runtime/server/live-rooms-file.mjs");

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowaki-rooms-"));
const file = path.join(dir, "sub", "rooms.json");

check("default path is .nowaki/live-rooms.json", roomsFilePath("/app", {}) === path.resolve("/app/.nowaki/live-rooms.json"));
check("NOWAKI_LIVE_ROOMS_FILE=off disables it", roomsFilePath("/app", { NOWAKI_LIVE_ROOMS_FILE: "off" }) === null);
check("a missing file loads nothing", loadRooms(file) === 0);

importRooms({ "poll:demo": { a: 3, b: 1 } });
check("saving creates the directory and the file", saveRooms(file) && fs.existsSync(file));
check("no temp file is left behind", fs.readdirSync(path.dirname(file)).length === 1);
importRooms({ "poll:demo": { a: 0, b: 0 } });
check("loading restores the saved state", loadRooms(file) === 1 && exportRooms()["poll:demo"].a === 3);

fs.writeFileSync(file, JSON.stringify({ format: 1, rooms: { "bad id": {}, ok: { n: 1 } } }));
check("ids that live.room couldn't produce are dropped", loadRooms(file) === 1 && !("bad id" in exportRooms()));

fs.writeFileSync(file, "{not json");
check("a corrupt file is ignored, not fatal", loadRooms(file) === 0);
fs.writeFileSync(file, JSON.stringify({ format: 99, rooms: {} }));
check("an unknown format is ignored", loadRooms(file) === 0);

importRooms({ big: { n: 1n } });
check("a shared state JSON can't hold is not saved (no throw)", saveRooms(file) === false);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\nLIVE ROOMS FILE TEST FAILED (${failures})` : "\nLIVE ROOMS FILE TEST PASSED");
process.exit(failures ? 1 : 0);
