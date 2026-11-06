// Folds results/*.jsonl into results/summary.json and results/summary.md: per framework and size,
// the latest series; build times as median [p25–p75] of the non-warm-up runs; a least-squares fit
// of the cold-build medians over the sizes (fixed ms + ms per entry).
// Usage: node benchmarks/docs-site/summarize.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const R = process.env.DOCS_RESULTS ? path.resolve(process.env.DOCS_RESULTS) : path.join(import.meta.dirname, "results");
const lines = (f) =>
  existsSync(path.join(R, f)) ? readFileSync(path.join(R, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const q = (s, p) => {
  const i = (s.length - 1) * p;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? { n: s.length, median: Math.round(q(s, 0.5)), p25: Math.round(q(s, 0.25)), p75: Math.round(q(s, 0.75)), runs: xs } : null;
};
const latestSeries = (rows) => rows.reduce((m, r) => (r.series > m ? r.series : m), "");

const runs = lines("runs.jsonl");
const output = lines("output.jsonl");
const browser = lines("browser.jsonl");
const out = {};
let machine = "";
let measured = "";
for (const fw of ["nowaki", "astro"]) {
  const mine = runs.filter((r) => r.framework === fw);
  if (!mine.length) continue;
  const sizes = {};
  for (const n of [...new Set(mine.map((r) => r.entries))].sort((a, b) => a - b)) {
    const at = mine.filter((r) => r.entries === n);
    const series = latestSeries(at);
    const rows = at.filter((r) => r.series === series);
    const pick = (kind) => stats(rows.filter((r) => r.kind === kind && !r.warmup).map((r) => r.ms));
    const o = output.filter((r) => r.framework === fw && r.series === series).at(-1);
    const pages = Object.fromEntries(
      browser
        .filter((r) => r.framework === fw && r.series === series)
        .map((b) => [b.page, { jsKB: b.jsKB, totalKB: b.totalKB, byTypeKB: b.byTypeKB, requests: b.requests }]),
    );
    sizes[n] = { cold: pick("cold"), warm: pick("warm"), output: o ? { ...o, framework: undefined, label: undefined, series: undefined, at: undefined, machine: undefined, commit: undefined, version: undefined, entries: undefined } : null, pages, version: rows[0].version, commit: rows[0].commit };
    if (rows[0].at > measured) [measured, machine] = [rows[0].at, rows[0].machine];
  }
  const pts = Object.entries(sizes).filter(([, c]) => c.cold).map(([n, c]) => [Number(n), c.cold.median]);
  let fit = null;
  if (pts.length >= 2) {
    const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
    const my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
    const b = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
    fit = { fixedMs: Math.round(my - b * mx), perEntryMs: Math.round(b * 100) / 100 };
  }
  out[fw] = { label: mine[0].label, version: mine.at(-1).version, sizes, coldFit: fit };
}

const summary = { measured: measured.slice(0, 10), machine, frameworks: out };
writeFileSync(path.join(R, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const md = [`Measured ${summary.measured} · ${machine}`, "", "| framework | entries | cold build (ms) | warm build (ms) | HTML | images | first-load JS (md / mdx / list) | sitemap URLs |", "|---|---|---|---|---|---|---|---|"];
for (const f of Object.values(out)) {
  for (const [n, c] of Object.entries(f.sizes)) {
    const r = (s) => (s ? `${s.median} [${s.p25}–${s.p75}]` : "—");
    const o = c.output;
    const js = ["md", "mdx", "list"].map((p) => c.pages[p]?.jsKB ?? "—").join(" / ");
    md.push(`| ${f.label} ${c.version} | ${n} | ${r(c.cold)} | ${r(c.warm)} | ${o ? `${o.html.KB} KB` : "—"} | ${o ? `${o.images.KB} KB (${o.images.files} files)` : "—"} | ${js} KB | ${o?.sitemapUrls ?? "—"} |`);
  }
}
md.push("", "| framework | cold build: fixed (ms) | per entry (ms) |", "|---|---|---|");
for (const f of Object.values(out)) md.push(`| ${f.label} | ${f.coldFit?.fixedMs ?? "—"} | ${f.coldFit?.perEntryMs ?? "—"} |`);
writeFileSync(path.join(R, "summary.md"), `${md.join("\n")}\n`);
console.log(md.join("\n"));
