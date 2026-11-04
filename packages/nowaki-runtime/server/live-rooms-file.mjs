// `nowaki start`: keep Jetstream rooms (`live.shared()` state) across a restart. Node only.
//
// The rooms live in this process (live.mjs). After a change they are written to a JSON file at
// most every 2 s, through a temp file + rename so a crash mid-write leaves the old file intact,
// and once more on SIGTERM / SIGINT. On start the file is loaded back. A hard kill (SIGKILL, power
// loss) loses at most the last 2 s.
//
// NOWAKI_LIVE_ROOMS_FILE: the file (relative to the app root); `off` disables it.
// Default: .nowaki/live-rooms.json.

import fs from "node:fs";
import path from "node:path";
import { exportRooms, importRooms, onRoomsChange } from "./live.mjs";

const FORMAT = 1;
const WRITE_EVERY_MS = 2000;

export function roomsFilePath(appRoot, env = process.env) {
  const setting = env.NOWAKI_LIVE_ROOMS_FILE;
  if (setting === "off") return null;
  return path.resolve(appRoot, setting || ".nowaki/live-rooms.json");
}

export function loadRooms(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[nowaki live] could not read ${file}: ${err.message}`);
    return 0;
  }
  try {
    const data = JSON.parse(text);
    if (data?.format !== FORMAT || typeof data.rooms !== "object") throw new Error("unknown format");
    return importRooms(data.rooms);
  } catch (err) {
    console.warn(`[nowaki live] ignoring ${file} (${err.message}); rooms start empty`);
    return 0;
  }
}

export function saveRooms(file) {
  let json;
  try {
    json = JSON.stringify({ format: FORMAT, savedAt: new Date().toISOString(), rooms: exportRooms() });
  } catch (err) {
    // A shared state that JSON can't hold (BigInt, a cycle): keep running, just don't persist.
    console.warn(`[nowaki live] rooms not saved: shared state is not JSON (${err.message})`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[nowaki live] could not write ${file}: ${err.message}`);
    return false;
  }
}

/// Loads the saved rooms and keeps the file up to date. Returns a flush function (or null if off).
export function persistRooms(appRoot, env = process.env) {
  const file = roomsFilePath(appRoot, env);
  if (!file) return null;
  loadRooms(file);
  let dirty = false;
  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (dirty) {
      dirty = false;
      saveRooms(file);
    }
  };
  onRoomsChange(() => {
    dirty = true;
    timer ??= setTimeout(flush, WRITE_EVERY_MS);
    timer.unref?.();
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.once(sig, () => {
      flush();
      process.exit(0);
    });
  }
  return flush;
}
