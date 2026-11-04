// Folds results/runs.jsonl and results/browser.jsonl into results/summary.json and prints
// Markdown tables (results/summary.md).
//   - For each framework × scale × metric, the latest series (one run.mjs invocation) is used,
//     warm-up runs excluded. Reported: n, median, p25, p75, min, max (ms).
//   - Scaling fits, per framework and metric:
//       pages    least squares over the islands = 1 scales: ms ≈ fixed + perPage × pages
//       islands  the two pages = 10 scales: perIsland = (ms at 10 islands − ms at 1) / 9
// Usage: node benchmarks/compare/summarize.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FRAMEWORKS, ORDER } from "./lib/frameworks.mjs";

const R = process.env.COMPARE_RESULTS ? path.resolve(process.env.COMPARE_RESULTS) : path.join(import.meta.dirname, "results");
const lines = (f) =>
  existsSync(path.join(R, f))
    ? readFileSync(path.join(R, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

const quantile = (sorted, q) => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
};
function stats(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  return { n: s.length, median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), min: s[0], max: s.at(-1), runs: xs };
}
const latest = (rows) => {
  const last = rows.reduce((m, r) => (r.series > m ? r.series : m), "");
  return rows.filter((r) => r.series === last);
};
const scaleKey = (r) => `${r.pages}x${r.islands}`;

const METRICS = {
  devReady: { metric: "dev", field: "readyMs", label: "dev ready line (cold)" },
  devFirst: { metric: "dev", field: "firstMs", label: "dev first response of / (cold)" },
  devPost: { metric: "dev", field: "postMs", label: "dev first response of a second route" },
  static: { metric: "static", field: "ms", label: "static build (every page to HTML)" },
  server: { metric: "server", field: "ms", label: "server build (render per request)" },
};

const runs = lines("runs.jsonl");
const browser = lines("browser.jsonl");
const out = {};
let measured = "";
let machine = "";
const commits = new Set();

for (const fw of ORDER) {
  const mine = runs.filter((r) => r.framework === fw);
  if (!mine.length) continue;
  const cells = {};
  for (const scale of [...new Set(mine.map(scaleKey))]) {
    const cell = (cells[scale] = {});
    for (const [key, m] of Object.entries(METRICS)) {
      const rows = latest(mine.filter((r) => scaleKey(r) === scale && r.metric === m.metric));
      const st = stats(rows.filter((r) => !r.warmup).map((r) => r[m.field]));
      if (!st) continue;
      cell[key] = st;
      for (const r of rows) {
        commits.add(r.commit);
        if (r.at > measured) [measured, machine] = [r.at, r.machine];
      }
    }
    // Post-page rows are matched to `/` through their series: rows written before the browser
    // result's island count was renamed to islandsOnPage carry islands = 0 there.
    const home = latest(browser.filter((r) => r.framework === fw && scaleKey(r) === scale && r.page === "/")).at(-1);
    const post = home && browser.filter((r) => r.framework === fw && r.series === home.series && r.page === "post").at(-1);
    for (const [key, b] of [
      ["home", home],
      ["post", post],
    ]) {
      if (!b) continue;
      const { jsKB, jsFileKB, inlineKB, idleKB, totalKB, byTypeKB, requests, jsFiles, hydrated } = b;
      cell[key] = { jsKB, jsFileKB, inlineKB, idleKB, totalKB, byTypeKB, requests, jsFiles, hydrated };
    }
  }
  // Scaling fits from the medians.
  const fits = { pages: {}, islands: {} };
  const byPages = Object.entries(cells)
    .map(([k, c]) => [k.split("x").map(Number), c])
    .filter(([[, i]]) => i === 1)
    .sort(([[a]], [[b]]) => a - b);
  for (const key of Object.keys(METRICS)) {
    const pts = byPages.filter(([, c]) => c[key]).map(([[p], c]) => [p, c[key].median]);
    if (pts.length >= 2) {
      const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
      const my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
      const b = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
      fits.pages[key] = { fixedMs: Math.round(my - b * mx), perPageMs: Math.round(b * 100) / 100, points: pts.length };
    }
    const one = cells["10x1"]?.[key];
    const ten = cells["10x10"]?.[key];
    if (one && ten) fits.islands[key] = { perIslandMs: Math.round(((ten.median - one.median) / 9) * 10) / 10 };
  }
  const one = cells["10x1"]?.home;
  const ten = cells["10x10"]?.home;
  if (one && ten) fits.islands.homeJs = { perIslandKB: Math.round(((ten.jsKB - one.jsKB) / 9) * 100) / 100 };
  out[fw] = { label: FRAMEWORKS[fw].label, version: mine.at(-1).version, cells, fits };
}

// Production servers (prod.mjs): per label (a framework, or a framework with extra env), the
// latest series, median of its runs for every number.
const prodRows = lines("prod.jsonl");
const prod = {};
const med = (xs) => stats(xs)?.median ?? null;
for (const lab of [...new Set(prodRows.map((r) => r.label))]) {
  const rows = latest(prodRows.filter((r) => r.label === lab));
  const pick = (f) => med(rows.map(f));
  const r0 = rows[0];
  prod[lab] = {
    framework: r0.framework,
    label: r0.fwLabel,
    version: r0.version,
    env: r0.env,
    isr: Boolean(r0.isr),
    pages: r0.pages,
    islands: r0.islands,
    runs: rows.length,
    startMs: pick((r) => r.startMs),
    idleMB: pick((r) => r.idleMB),
    peakMB: pick((r) => r.peakMB),
    ttfbP50: pick((r) => r.latency.ttfbP50),
    ttfbP99: pick((r) => r.latency.ttfbP99),
    totalP50: pick((r) => r.latency.totalP50),
    postRps: pick((r) => r.post.rps),
    postP99: pick((r) => r.post.p99),
    homeRps: pick((r) => r.home.rps),
    homeP99: pick((r) => r.home.p99),
    postRpsRuns: rows.map((r) => r.post.rps),
    homeRpsRuns: rows.map((r) => r.home.rps),
    oha: r0.oha,
  };
}

const summary = { measured: measured.slice(0, 10), machine, commits: [...commits], metrics: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, m.label])), frameworks: out, prod };
writeFileSync(path.join(R, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

// Markdown: one table per metric, a column per scale.
const scales = [...new Set(Object.values(out).flatMap((f) => Object.keys(f.cells)))].sort((a, b) => {
  const [pa, ia] = a.split("x").map(Number);
  const [pb, ib] = b.split("x").map(Number);
  return ia - ib || pa - pb;
});
const head = (title) => [`### ${title}`, "", `| framework | ${scales.map((s) => s.replace("x", " pages × ") + " islands").join(" | ")} |`, `|---|${scales.map(() => "---|").join("")}`];
const md = [`Measured ${summary.measured} · ${machine} · commit ${[...commits].join(", ")}`, ""];
for (const [key, m] of Object.entries(METRICS)) {
  md.push(...head(`${m.label} — median ms [p25–p75]`));
  for (const f of Object.values(out)) {
    const cols = scales.map((s) => {
      const st = f.cells[s]?.[key];
      return st ? `${Math.round(st.median)} [${Math.round(st.p25)}–${Math.round(st.p75)}]` : "—";
    });
    md.push(`| ${f.label} ${f.version} | ${cols.join(" | ")} |`);
  }
  md.push("");
}
for (const [page, title] of [
  ["home", "`/` in the browser — JS / total transfer, KB gzip"],
  ["post", "a post page in the browser — JS / total transfer, KB gzip"],
]) {
  md.push(...head(title));
  for (const f of Object.values(out)) {
    const cols = scales.map((s) => {
      const b = f.cells[s]?.[page];
      return b ? `${b.jsKB} / ${b.totalKB}${b.idleKB ? ` (${b.idleKB} idle)` : ""}` : "—";
    });
    md.push(`| ${f.label} ${f.version} | ${cols.join(" | ")} |`);
  }
  md.push("");
}
md.push("### Scaling — fixed cost and marginal cost (from the medians)", "", "| framework | metric | fixed (ms) | per page (ms) | per island (ms) |", "|---|---|---|---|---|");
for (const f of Object.values(out)) {
  for (const key of Object.keys(METRICS)) {
    const p = f.fits.pages[key];
    const i = f.fits.islands[key];
    if (p || i) md.push(`| ${f.label} | ${METRICS[key].label} | ${p?.fixedMs ?? "—"} | ${p?.perPageMs ?? "—"} | ${i?.perIslandMs ?? "—"} |`);
  }
  if (f.fits.islands.homeJs) md.push(`| ${f.label} | JS on \`/\` per island (KB gzip) | | | ${f.fits.islands.homeJs.perIslandKB} |`);
}
if (Object.keys(prod).length) {
  const p0 = Object.values(prod)[0];
  md.push(
    "",
    `### Production servers — ${p0.pages} pages × ${p0.islands} island, rendered per request, median of runs`,
    "",
    "| server | start (ms) | idle RSS (MB) | peak RSS (MB) | TTFB p50 / p99 (ms, 1 conn) | post pages req/s (p99 ms, 50 conns) | `/` req/s (p99 ms, 50 conns) |",
    "|---|---|---|---|---|---|---|",
  );
  for (const p of Object.values(prod)) {
    const notes = [...Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`), ...(p.isr ? ["ISR on post pages, 60 s"] : [])];
    const name = `${p.label} ${p.version}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    md.push(`| ${name} | ${p.startMs} | ${p.idleMB} | ${p.peakMB} | ${p.ttfbP50} / ${p.ttfbP99} | ${p.postRps} (${p.postP99}) | ${p.homeRps} (${p.homeP99}) |`);
  }
}
writeFileSync(path.join(R, "summary.md"), `${md.join("\n")}\n`);
console.log(md.join("\n"));
