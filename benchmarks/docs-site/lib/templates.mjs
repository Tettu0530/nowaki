// The docs site in Nowaki and in Astro, each written the way its docs show. `files(n)` returns
// { relativePath: contents } for the generated sources; package.json, pnpm-workspace.yaml and
// the lockfile are committed. Pages: / (home), /docs/ (every entry, by order), /docs/<slug>/
// (a table of contents from the h2 headings, then the entry). The photos are copied from
// ../assets; everything else is generated.

import { entries } from "./content.mjs";

export const SITE = "https://docs.example.com";
export const MARK_ENTRY = "bench-marker-entry";
export const MARK_LIST = "bench-marker-list";

export const CSS = `:root { --fg: #1b1f24; --muted: #5b6470; --accent: #2563eb; --line: #d9dee5; --field: #f6f8fa; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--fg); font: 16px/1.65 system-ui, sans-serif; }
.page { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem; }
header { display: flex; gap: 1rem; padding-bottom: .75rem; border-bottom: 1px solid var(--line); }
a { color: var(--accent); text-decoration: none; }
h1 { font-size: 2rem; line-height: 1.2; }
h2 { margin-top: 2.25rem; }
.toc { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: .9rem; padding: .75rem 0; border-bottom: 1px solid var(--line); }
pre { overflow-x: auto; padding: .85rem 1rem; border: 1px solid var(--line); border-radius: 6px; font-size: .875rem; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: .4rem .6rem; border-bottom: 1px solid var(--line); text-align: left; }
img { max-width: 100%; height: auto; border-radius: 6px; }
.callout { margin: 1.25rem 0; padding: .75rem 1rem; border-left: 4px solid var(--accent); background: var(--field); border-radius: 0 6px 6px 0; }
.callout strong { display: block; }
.list li { margin: .35rem 0; }
.list p { margin: .1rem 0 0; color: var(--muted); font-size: .9rem; }
footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; border-top: 1px solid var(--line); padding-top: .75rem; }
`;

const PHOTOS = [1, 2, 3, 4];

// ---------------------------------------------------------------- Nowaki
function nowaki(n) {
  const f = {};
  f["nowaki.config.mjs"] = `export default { site: ${JSON.stringify(SITE)} };\n`;
  f["styles/global.css"] = CSS;
  // A Standard Schema by hand, as examples/hello does: the docs need no third-party code.
  f["content/config.ts"] = `import { defineCollection } from "@nowaki-dev/runtime/content";

type Doc = { title: string; description: string; order: number };

const doc = {
  "~standard": {
    version: 1 as const,
    vendor: "docs-bench",
    validate(v: unknown) {
      const d = (v ?? {}) as Record<string, unknown>;
      const issues = [];
      if (typeof d.title !== "string" || !d.title) issues.push({ message: "is required", path: ["title"] });
      if (typeof d.description !== "string") issues.push({ message: "is required", path: ["description"] });
      if (typeof d.order !== "number") issues.push({ message: "must be a number", path: ["order"] });
      if (issues.length) return { issues };
      return { value: { title: d.title, description: d.description, order: d.order } as Doc };
    },
    types: undefined as unknown as { input: unknown; output: Doc },
  },
};

export const docs = defineCollection({ schema: doc });
`;
  f["components/Callout.tsx"] = `export default function Callout({ title, children }: { title: string; children?: unknown }) {
  return (
    <aside class="callout">
      <strong>{title}</strong>
      {children}
    </aside>
  );
}
`;
  f["routes/_layout.tsx"] = `import "../styles/global.css";

export default function Layout({ children }: { children: unknown }) {
  return (
    <div class="page">
      <header>
        <a href="/">Home</a>
        <a href="/docs/">Docs</a>
      </header>
      {children}
      <footer>Built for the docs-site benchmark.</footer>
    </div>
  );
}
`;
  f["routes/index.tsx"] = `export const title = "Docs benchmark";

export default function Home() {
  return (
    <main>
      <h1>Docs benchmark</h1>
      <p>A docs site built from a typed content collection.</p>
      <p><a href="/docs/">All docs</a></p>
    </main>
  );
}
`;
  f["routes/docs/index.tsx"] = `import { getCollection } from "@nowaki-dev/runtime/content";

export const title = "All docs";

export const loader = async () => {
  const docs = await getCollection("docs");
  return docs
    .sort((a, b) => a.data.order - b.data.order)
    .map((d) => ({ slug: d.slug, title: d.data.title, description: d.data.description }));
};

export default function Docs({ data }: { data: { slug: string; title: string; description: string }[] }) {
  return (
    <main>
      <h1>All docs</h1>
      <p data-bench="list">${MARK_LIST}</p>
      <ul class="list">
        {data.map((d) => (
          <li>
            <a href={\`/docs/\${d.slug}/\`}>{d.title}</a>
            <p>{d.description}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
  f["routes/docs/[slug].tsx"] = `import { getCollection, getEntry } from "@nowaki-dev/runtime/content";
import type { LoaderContext } from "@nowaki-dev/runtime";
import { h } from "preact";

export const staticPaths = async () => (await getCollection("docs")).map((d) => ({ slug: d.slug }));

export const loader = async (ctx: LoaderContext) => {
  const doc = await getEntry("docs", String(ctx.params.slug));
  if (!doc) return ctx.redirect("/docs/");
  // MDX entries render as a component; Markdown entries come as HTML rendered at build time.
  const mdx = doc.render ? await doc.render() : null;
  return { title: doc.data.title, html: doc.html ?? "", headings: doc.headings ?? [], Content: mdx?.Content };
};

export const meta = ({ data }: { data: { title: string } }) => ({ title: data.title, canonical: true as const });

type Props = {
  data: {
    title: string;
    html: string;
    headings: { depth: number; text: string; id: string }[];
    Content?: (props?: Record<string, unknown>) => unknown;
  };
};

export default function Doc({ data }: Props) {
  return (
    <main>
      <h1>{data.title}</h1>
      <p data-bench="entry">${MARK_ENTRY}</p>
      <nav class="toc">
        {data.headings
          .filter((x) => x.depth === 2)
          .map((x) => (
            <a href={\`#\${x.id}\`}>{x.text}</a>
          ))}
      </nav>
      {data.Content ? <article>{h(data.Content as never, null)}</article> : <article dangerouslySetInnerHTML={{ __html: data.html }} />}
    </main>
  );
}
`;
  for (const e of entries(n, { calloutImport: "../../components/Callout.tsx", imagePath: (k) => `../../assets/photo-${k}.jpg` })) {
    f[`content/docs/${e.file}`] = e.text;
  }
  return f;
}

// ---------------------------------------------------------------- Astro
function astro(n) {
  const f = {};
  // Responsive images: Markdown images get srcset/sizes (constrained layout), made by astro:assets.
  f["astro.config.mjs"] = `import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: ${JSON.stringify(SITE)},
  integrations: [mdx(), sitemap()],
  image: { layout: "constrained" },
});
`;
  f["tsconfig.json"] = `{ "extends": "astro/tsconfigs/strict", "include": [".astro/types.d.ts", "**/*"], "exclude": ["dist"] }\n`;
  f["src/styles/global.css"] = CSS;
  f["src/content.config.ts"] = `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
  schema: z.object({ title: z.string(), description: z.string(), order: z.number() }),
});

export const collections = { docs };
`;
  f["src/components/Callout.astro"] = `---
const { title } = Astro.props;
---

<aside class="callout">
  <strong>{title}</strong>
  <slot />
</aside>
`;
  f["src/layouts/Base.astro"] = `---
import "../styles/global.css";

const { title } = Astro.props;
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <link rel="canonical" href={new URL(Astro.url.pathname, Astro.site)} />
  </head>
  <body>
    <div class="page">
      <header>
        <a href="/">Home</a>
        <a href="/docs/">Docs</a>
      </header>
      <slot />
      <footer>Built for the docs-site benchmark.</footer>
    </div>
  </body>
</html>
`;
  f["src/pages/index.astro"] = `---
import Base from "../layouts/Base.astro";
---

<Base title="Docs benchmark">
  <main>
    <h1>Docs benchmark</h1>
    <p>A docs site built from a typed content collection.</p>
    <p><a href="/docs/">All docs</a></p>
  </main>
</Base>
`;
  f["src/pages/docs/index.astro"] = `---
import { getCollection } from "astro:content";
import Base from "../../layouts/Base.astro";

const docs = (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order);
---

<Base title="All docs">
  <main>
    <h1>All docs</h1>
    <p data-bench="list">${MARK_LIST}</p>
    <ul class="list">
      {
        docs.map((d) => (
          <li>
            <a href={\`/docs/\${d.id}/\`}>{d.data.title}</a>
            <p>{d.data.description}</p>
          </li>
        ))
      }
    </ul>
  </main>
</Base>
`;
  f["src/pages/docs/[slug].astro"] = `---
import { getCollection, render } from "astro:content";
import Base from "../../layouts/Base.astro";

export async function getStaticPaths() {
  return (await getCollection("docs")).map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}

const { entry } = Astro.props;
const { Content, headings } = await render(entry);
---

<Base title={entry.data.title}>
  <main>
    <h1>{entry.data.title}</h1>
    <p data-bench="entry">${MARK_ENTRY}</p>
    <nav class="toc">
      {headings.filter((x) => x.depth === 2).map((x) => <a href={\`#\${x.slug}\`}>{x.text}</a>)}
    </nav>
    <article><Content /></article>
  </main>
</Base>
`;
  for (const e of entries(n, { calloutImport: "../../components/Callout.astro", imagePath: (k) => `../../assets/photo-${k}.jpg` })) {
    f[`src/content/docs/${e.file}`] = e.text;
  }
  return f;
}

export const TEMPLATES = { nowaki, astro };
export const PHOTO_DIRS = { nowaki: "assets", astro: "src/assets" };
export { PHOTOS };
