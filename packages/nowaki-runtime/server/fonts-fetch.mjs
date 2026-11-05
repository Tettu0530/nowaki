// Downloads Google Fonts for `nowaki build` / `nowaki dev`, so pages never request a third-party
// host: the CSS2 API's woff2 faces (one per subset, with its unicode-range) and one TrueType file
// for the fallback metrics. Everything is cached under <cacheDir>, so later builds work offline.
//
// Usage: node fonts-fetch.mjs <cacheDir> < specs.json   (an array of { family, weights, styles,
// subsets, display })  →  [{ family, faces: [{ weight, style, subset, unicodeRange, file }],
// metrics: <ttf path> }] on stdout.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const cacheDir = process.argv[2];
const specs = JSON.parse(readFileSync(0, "utf8"));
await mkdir(cacheDir, { recursive: true });

// Google picks the format by user agent: a current browser gets woff2 split by subset, anything
// else one TrueType file per face.
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PLAIN = "nowaki-fonts";

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);

async function cached(url, ua, ext) {
  const file = path.join(cacheDir, `${hash(ua + " " + url)}.${ext}`);
  if (existsSync(file)) return file;
  const res = await fetch(url, { headers: { "user-agent": ua } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

function cssUrl(spec) {
  const weights = (spec.weights?.length ? spec.weights : [400]).map(Number).sort((a, b) => a - b);
  const styles = spec.styles?.length ? spec.styles : ["normal"];
  const axes = [];
  for (const s of [...new Set(styles)].sort()) for (const w of weights) axes.push(`${s === "italic" ? 1 : 0},${w}`);
  const family = spec.family.trim().replace(/ +/g, "+");
  return `https://fonts.googleapis.com/css2?family=${family}:ital,wght@${axes.join(";")}&display=${spec.display ?? "swap"}`;
}

// `/* latin */\n@font-face { … }` blocks.
function faces(css) {
  const out = [];
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const body = m[2];
    const get = (k) => body.match(new RegExp(`${k}:\\s*([^;]+);`))?.[1]?.trim();
    out.push({
      subset: m[1] ?? null,
      style: get("font-style") ?? "normal",
      weight: Number(get("font-weight") ?? 400),
      unicodeRange: get("unicode-range") ?? null,
      url: body.match(/url\(([^)]+)\)/)?.[1]?.replace(/["']/g, ""),
    });
  }
  return out;
}

const result = [];
for (const spec of specs) {
  const url = cssUrl(spec);
  const css = await readFile(await cached(url, BROWSER, "css"), "utf8");
  const subsets = spec.subsets?.length ? spec.subsets : ["latin"];
  const list = [];
  for (const f of faces(css)) {
    if (!f.url || (f.subset && !subsets.includes(f.subset))) continue;
    list.push({ ...f, file: await cached(f.url, BROWSER, "woff2") });
  }
  if (list.length === 0) throw new Error(`${spec.family}: Google Fonts has no faces for subsets ${subsets.join(", ")}`);
  // Metrics from the TrueType of the first weight (the same family metrics for every face).
  const ttfCss = await readFile(await cached(url, PLAIN, "ttf.css"), "utf8");
  const ttfUrl = faces(ttfCss)[0]?.url;
  const metrics = ttfUrl ? await cached(ttfUrl, PLAIN, "ttf") : null;
  result.push({ family: spec.family, faces: list.map(({ url, ...f }) => f), metrics });
}
process.stdout.write(JSON.stringify(result));
