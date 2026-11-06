// Deterministic docs entries, the same text in both apps. Every 5th entry is MDX (it renders a
// static <Callout> component); the rest are Markdown. Each entry has three sections, a list, a
// table, three code fences (ts, bash, json) and one of the four photos, by a relative path.

const WORDS =
  "route layout island stream cache build deploy request response header render static dynamic module bundle server client page config schema entry collection image picture sitemap frontmatter heading anchor token signal pipeline adapter edge origin preview release".split(
    " ",
  );

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r) => WORDS[Math.floor(r() * WORDS.length)];
function sentence(r, min, max) {
  const n = min + Math.floor(r() * (max - min + 1));
  const w = Array.from({ length: n }, () => pick(r));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(" ")}.`;
}
const paragraph = (r) => Array.from({ length: 3 + Math.floor(r() * 3) }, () => sentence(r, 7, 15)).join(" ");
const title = (r) => sentence(r, 2, 4).slice(0, -1);

export const slugOf = (i) => `doc-${String(i).padStart(4, "0")}`;
export const isMdx = (i) => i % 5 === 0;

/**
 * @param {number} n entries
 * @param {{ calloutImport: string, imagePath: (k: number) => string }} paths per framework
 * @returns {{ file: string, text: string }[]} file is relative to the collection directory
 */
export function entries(n, paths) {
  const r = rng(20261105);
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const mdx = isMdx(i);
    const photo = (i % 4) + 1;
    const fm = [
      "---",
      `title: "${title(r)} (${i})"`,
      `description: "${sentence(r, 8, 12)}"`,
      `order: ${i}`,
      "---",
      "",
    ].join("\n");
    const body = [
      mdx ? `import Callout from "${paths.calloutImport}";\n` : "",
      paragraph(r),
      mdx ? `\n<Callout title="Note">\n${sentence(r, 8, 14)}\n</Callout>\n` : "",
      `## ${title(r)}`,
      paragraph(r),
      paragraph(r),
      `- ${sentence(r, 4, 7)}\n- ${sentence(r, 4, 7)}\n- ${sentence(r, 4, 7)}`,
      `## ${title(r)}`,
      "```ts",
      `export async function load${i}(slug: string): Promise<Entry | undefined> {`,
      "  const all = await getCollection(\"docs\");",
      "  const entry = all.find((e) => e.slug === slug);",
      `  if (!entry) return undefined; // ${pick(r)} ${pick(r)}`,
      "  return { ...entry, order: entry.data.order + 1 };",
      "}",
      "```",
      paragraph(r),
      "```bash",
      "npm run build",
      `curl -s http://localhost:3000/docs/${slugOf(i)}/ | head -n ${3 + (i % 7)}`,
      "```",
      `![${title(r)}](${paths.imagePath(photo)})`,
      `## ${title(r)}`,
      "| Option | Default | Notes |",
      "|---|---|---|",
      `| \`${pick(r)}\` | \`${i % 2 === 0}\` | ${sentence(r, 3, 6)} |`,
      `| \`${pick(r)}\` | \`${i * 3}\` | ${sentence(r, 3, 6)} |`,
      `| \`${pick(r)}\` | \`"${pick(r)}"\` | ${sentence(r, 3, 6)} |`,
      "```json",
      `{ "name": "${slugOf(i)}", "order": ${i}, "draft": false, "tags": ["${pick(r)}", "${pick(r)}"] }`,
      "```",
      `${paragraph(r)} See [the previous page](/docs/${slugOf(Math.max(1, i - 1))}/) or [all docs](/docs/).`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { file: `${slugOf(i)}.${mdx ? "mdx" : "md"}`, text: `${fm}${body}\n` };
  });
}
