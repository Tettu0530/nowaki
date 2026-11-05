// The parts of the blog beyond posts, written once per framework and added by templates.mjs:
//   - global CSS (with a dark theme) in the root layout, and a component-scoped CSS for the table
//   - ThemeToggle    island in the root layout, on every page (localStorage + data-theme)
//   - Search         island on /posts: debounced fetch of /api/search?q= and a result list
//   - SortTable      island on /stats: 50 rows passed from the server, sortable by column
//   - /contact       a form validated with zod on the server; Post/Redirect/Get to ?sent=1 or
//                    ?error=1. The POST handler exists in server mode only: Next.js static export
//                    has no Server Actions and SvelteKit cannot prerender a page with actions.
//   - /api/search    JSON, the 10 titles matching q. In static mode it is prerendered once
//                    (q ignored) where the framework can, and absent where it cannot (Nowaki, Nuxt).
// Every island sets data-island and, once mounted, data-hydrated, which the harness checks.

export const MARK_STATS = "bench-marker-stats";
export const MARK_CONTACT = "bench-marker-contact";

export const GLOBAL_CSS = `:root {
  color-scheme: light;
  --bg: #ffffff;
  --fg: #1b1f24;
  --muted: #5b6470;
  --accent: #2563eb;
  --line: #d9dee5;
  --field: #f6f8fa;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0e1116;
  --fg: #e6e9ee;
  --muted: #9aa4b2;
  --accent: #7aa2ff;
  --line: #2a313b;
  --field: #161b22;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-bottom: .75rem; border-bottom: 1px solid var(--line); }
nav { display: flex; gap: .75rem; flex-wrap: wrap; }
footer { margin-top: 3rem; padding-top: .75rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .875rem; }
h1 { font-size: 2rem; line-height: 1.2; margin: 1.5rem 0 1rem; }
h2 { font-size: 1.35rem; margin: 2rem 0 .75rem; }
time { color: var(--muted); font-size: .875rem; }
ul { padding-left: 1.25rem; }
li { margin: .4rem 0; }
pre { overflow-x: auto; padding: .75rem 1rem; background: var(--field); border: 1px solid var(--line); border-radius: 6px; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
button { font: inherit; padding: .35rem .75rem; border: 1px solid var(--line); border-radius: 6px; background: var(--field); color: var(--fg); cursor: pointer; }
button:hover { border-color: var(--accent); }
input, textarea { width: 100%; font: inherit; padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 6px; background: var(--field); color: var(--fg); }
textarea { min-height: 8rem; resize: vertical; }
label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
form button[type="submit"] { margin-top: 1rem; background: var(--accent); border-color: var(--accent); color: #fff; }
.notice { padding: .65rem .9rem; border-radius: 6px; border: 1px solid var(--line); background: var(--field); }
.notice[data-kind="error"] { border-color: #d14343; }
.results { list-style: none; padding: 0; }
.results li { padding: .35rem 0; border-bottom: 1px solid var(--line); }
`;

export const TABLE_CSS = `.table { width: 100%; border-collapse: collapse; font-size: .925rem; }
.table th, .table td { padding: .45rem .6rem; border-bottom: 1px solid var(--line); text-align: left; }
.table th button { all: unset; cursor: pointer; font-weight: 600; }
.table th button:hover { color: var(--accent); }
.active { color: var(--accent); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
`;

// Server-side helpers, the same code in every framework (JS that is also valid TS).
export const SEARCH_LIB = `// Titles matching q (case-insensitive), at most 10.
export function search(posts, q) {
  const needle = String(q ?? "").trim().toLowerCase();
  return posts
    .filter((p) => !needle || p.title.toLowerCase().includes(needle))
    .slice(0, 10)
    .map((p) => ({ slug: p.slug, title: p.title }));
}

// The 50 rows of /stats.
export function statsRows(posts) {
  return posts.slice(0, 50).map((p) => ({
    slug: p.slug,
    title: p.title,
    date: p.date,
    words: p.body.split(/\\s+/).length,
  }));
}
`;

export const CONTACT_SCHEMA = `import { z } from "zod";

export const Contact = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email(),
  message: z.string().trim().min(10).max(2000),
});
`;

// ---------------------------------------------------------------- Preact islands (Nowaki, Astro)
// `cssImport` is how the island imports TABLE_CSS as a CSS module.
export const preactIslands = (cssImport) => ({
  "ThemeToggle.tsx": `import { useEffect, useState } from "preact/hooks";

export default function ThemeToggle() {
  const [theme, setTheme] = useState("light");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("theme") ?? "light";
    document.documentElement.dataset.theme = saved;
    setTheme(saved);
    setReady(true);
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    setTheme(next);
  };
  return (
    <button type="button" data-island="theme" data-hydrated={ready ? "" : undefined} onClick={toggle}>
      {theme === "dark" ? "Light" : "Dark"} theme
    </button>
  );
}
`,
  "Search.tsx": `import { useEffect, useState } from "preact/hooks";

type Hit = { slug: string; title: string };

export default function Search() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (!q) return setHits([]);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(\`/api/search?q=\${encodeURIComponent(q)}\`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then(setHits)
        .catch(() => {});
    }, 150);
    return () => (clearTimeout(t), ctrl.abort());
  }, [q]);
  return (
    <div data-island="search" data-hydrated={ready ? "" : undefined}>
      <input type="search" placeholder="Search titles" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <ul class="results">
        {hits.map((h) => (
          <li key={h.slug}><a href={\`/posts/\${h.slug}\`}>{h.title}</a></li>
        ))}
      </ul>
    </div>
  );
}
`,
  "SortTable.tsx": `import { useEffect, useState } from "preact/hooks";
${cssImport}

type Row = { slug: string; title: string; date: string; words: number };
type Key = keyof Row;
const COLUMNS: [Key, string][] = [["title", "Title"], ["date", "Date"], ["words", "Words"]];

export default function SortTable({ rows }: { rows: Row[] }) {
  const [key, setKey] = useState<Key>("date");
  const [asc, setAsc] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const sorted = [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (asc ? 1 : -1));
  const sortBy = (k: Key) => (k === key ? setAsc(!asc) : (setKey(k), setAsc(true)));
  return (
    <table class={styles.table} data-island="table" data-hydrated={ready ? "" : undefined}>
      <thead>
        <tr>
          {COLUMNS.map(([k, label]) => (
            <th key={k} class={k === "words" ? styles.num : undefined}>
              <button type="button" class={k === key ? styles.active : undefined} onClick={() => sortBy(k)}>
                {label} {k === key ? (asc ? "↑" : "↓") : ""}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.slug}>
            <td><a href={\`/posts/\${r.slug}\`}>{r.title}</a></td>
            <td><time>{r.date}</time></td>
            <td class={styles.num}>{r.words}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
`,
});

// The markup /contact renders in every framework, given how to print the status line and the
// form's action attribute.
export const contactBody = ({ status, action }) => `<h1>Contact</h1>
<p data-bench="contact">${MARK_CONTACT}</p>
${status}
<form method="post"${action ? ` action="${action}"` : ""}>
  <label for="name">Name</label>
  <input id="name" name="name" required maxlength="80" />
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required />
  <label for="message">Message</label>
  <textarea id="message" name="message" required minlength="10" maxlength="2000"></textarea>
  <button type="submit">Send</button>
</form>`;
