// Checks `nowaki build`'s first-load JS report (dist/route-js.json) against the HTML that
// `nowaki start` actually serves: for every static page route, each script and modulepreload the
// page references must be one of the chunks the report counted. (The report can count more: it
// includes every island a page *can* render.)
// Usage: node scripts/route-js-e2e.mjs <baseUrl> <appDir>
import fs from "node:fs";
import path from "node:path";

const [base, appDir] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(path.join(appDir, "dist/route-js.json"), "utf8"));
const clientDir = path.join(appDir, "dist/client");
let failures = 0;
let compared = 0;
let exact = 0;
for (const r of report) {
  if (r.url.includes("[")) continue; // dynamic: no URL to fetch
  const res = await fetch(base + r.url, { redirect: "manual" });
  if (res.status !== 200) continue;
  const html = await res.text();
  const files = new Set();
  for (const m of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="\/_nowaki\/([^"]+)"/g)) {
    files.add(m[1]);
  }
  // The lazy router chunk is referenced in data-router, never as src/href: not first load.
  const counted = new Set(r.chunks);
  const missing = [...files].filter((f) => !counted.has(f));
  compared++;
  if (files.size === counted.size) exact++;
  const ok = missing.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${r.url}: serves ${files.size} chunk(s), report counts ${counted.size}${ok ? "" : `; not counted: ${missing.join(", ")}`}`);
}
if (compared < 5) {
  console.log(`FAIL only ${compared} routes compared`);
  failures++;
}
console.log(`\n${compared} routes compared, ${exact} exact`);
console.log(failures ? `ROUTE JS E2E FAILED (${failures})` : "ROUTE JS E2E PASSED");
process.exit(failures ? 1 : 0);
