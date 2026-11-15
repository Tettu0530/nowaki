# Content: collections, Markdown, MDX and Markdoc

Content collections keep Markdown, MDX, Markdoc and data files under `content/`, validate their
frontmatter with a schema, and give loaders typed entries. Markdown is rendered at build time,
in Rust, with heading anchors and code highlighting, so no Markdown library runs on the server
or in the browser.

## Define a collection

Each directory under `content/` is a collection, declared as a named export of
`content/config.ts` (or `.js` / `.mjs` / `.mts`):

```
content/
  config.ts
  blog/
    hello.md
    deep-dive.mdx
  authors/
    ada.json
```

```ts
// content/config.ts
import { z } from "zod";
import { defineCollection } from "@nowaki-dev/runtime/content";

export const blog = defineCollection({
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false),
  }),
});

export const authors = defineCollection({
  type: "data",
  schema: z.object({ name: z.string(), url: z.string().url().optional() }),
});
```

- `type: "markdown"` (the default) reads `.md` and `.mdx` files (and `.mdoc` with the Markdoc
  plugin) with YAML (`---`) or TOML (`+++`) frontmatter. `type: "data"` reads `.json` and
  `.yaml` files.
- `schema` is any Standard Schema (Zod, Valibot, ArkType, or a hand-written one as in
  `examples/hello/content/config.ts`). An invalid entry fails `nowaki build`, listing each
  problem as `content/blog/x.md: title: ...`. In `nowaki dev` the error shows in the overlay
  and the server keeps running.
- A directory under `content/` without an export in `content/config.ts` is an error naming
  the export to add.
- TOML datetimes and YAML dates arrive as strings: coerce them in the schema (`z.coerce.date()`)
  to get `Date`s.
- `nowaki typegen` (also run by `dev` and `build`) types each collection by its schema's output,
  so `entry.data` is typed.

## Read entries

```tsx
// routes/blog/index.tsx
import { getCollection } from "@nowaki-dev/runtime/content";
import type { PageProps } from "@nowaki-dev/runtime";

export async function loader() {
  const posts = await getCollection("blog", (p) => !p.data.draft);
  return posts
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
    .map((p) => ({ slug: p.slug, title: p.data.title }));
}

export default function Blog({ data }: PageProps<typeof loader>) {
  return <ul>{data.map((p) => <li><a href={`/blog/${p.slug}`}>{p.title}</a></li>)}</ul>;
}
```

```tsx
// routes/blog/[slug].tsx
import { h } from "preact";
import { getCollection, getEntry } from "@nowaki-dev/runtime/content";
import type { LoaderContext } from "@nowaki-dev/runtime";

type Data = { title: string; html: string; Content?: (props?: Record<string, unknown>) => unknown };

export const staticPaths = async () => (await getCollection("blog")).map((p) => ({ slug: p.slug }));

export async function loader(ctx: LoaderContext) {
  const post = await getEntry("blog", String(ctx.params.slug));
  if (!post) return ctx.redirect("/blog");
  const mod = post.render ? await post.render() : null; // MDX / Markdoc
  return { title: post.data.title, html: post.html ?? "", Content: mod?.Content } satisfies Data;
}

// The loader can also return a redirect, so the page types `data` itself.
export default function Post({ data }: { data: Data }) {
  return (
    <article>
      <h1>{data.title}</h1>
      {data.Content ? h(data.Content as never, null) : <div dangerouslySetInnerHTML={{ __html: data.html }} />}
    </article>
  );
}
```

- `getCollection(name, filter?)` returns every entry sorted by slug. `filter` is a function or
  `{ filter, locale }`.
- `getEntry(name, slug)` returns one entry or `undefined`.
- Both throw for an unknown collection name.
- An entry has `collection`, `slug` (its path under the collection without the extension:
  `posts/hello`), `file`, `data`, and for Markdown `body`, `html` and `headings`. MDX and
  Markdoc entries have `render()`, which returns `{ Content, headings }`.

Working examples: `examples/hello/content/`, `examples/hello/routes/docs/index.tsx` and
`[slug].tsx`, `examples/hello/routes/feed.xml.ts`.

## Markdown

Markdown entries are rendered by comrak with GitHub Flavored Markdown: tables, task lists,
strikethrough, footnotes and autolinks.

- Every heading gets an anchor id, and `entry.headings` (`{ depth, text, id }[]`) lists them for
  a table of contents.
- Fenced code with a language (` ```tsx `) is highlighted at build time with inline styles, so
  it needs no client JS or theme CSS and works under an enforced CSP. A block without a language,
  or with an unknown one, stays plain text.
- The highlight colors follow the page's color scheme: each one is written as the light color
  (GitHub light) followed by `light-dark(<light>, <dark>)` with its GitHub-dark counterpart. For
  dark code blocks, set `color-scheme: dark` on the page (or `color-scheme: light dark` to follow
  the OS setting), e.g. `:root { color-scheme: light dark; }`. A page without `color-scheme`
  renders light code blocks, as before. `light-dark()` is Baseline 2024 (Chrome and Edge 123,
  Firefox 120, Safari 17.5); an older browser ignores it and keeps the light colors.
- `![alt](./hero.jpg "title")` with a local file becomes a responsive `<picture>` like
  [`<Image>`](./images-and-fonts.md); a missing file fails the build. Root-relative (`/logo.svg`)
  and remote URLs stay as written, except remote ones allowed by `images.remotePatterns`, which
  are optimized too.
- **Raw HTML in Markdown is passed through.** Treat content files as code you trust. An inline
  `<script>` or `<style>` in Markdown gets no CSP nonce, so `NOWAKI_CSP=enforce` blocks it (see
  [Security](./security.md#content-security-policy)).

## MDX

`.mdx` files are Markdown with JSX, `{expressions}`, and `import` / `export`. They work as
content entries and as pages (`routes/guide.mdx` serves `/guide`).

```mdx
---
title: Components in MDX
---
import Counter from "../../islands/Counter.tsx";
export const answer = 6 * 7;

# Components in MDX

The answer is {answer}.

<Counter start={answer} client:visible />
```

- MDX is compiled in Rust to TSX before the usual transform. Imported components and islands
  work as in TSX, in dev, the builds and every adapter.
- Code is highlighted like Markdown, local images go through `?image`, and heading ids match
  Markdown's. Each module exports `headings`.
- In an `.mdx` page, YAML frontmatter is ignored: use `export const title`, `meta` and the other
  route exports.

Working examples: `examples/hello/routes/guide.mdx`, `examples/hello/content/docs/components.mdx`.

## Markdoc

[Markdoc](https://markdoc.dev) comes from the `@nowaki-dev/markdoc` plugin. With it, `.mdoc`
files compile to Preact modules at build and dev time; no Markdoc code reaches the server bundle
or the browser.

```sh
npm install @nowaki-dev/markdoc
```

```js
// nowaki.config.mjs
import { defineConfig } from "@nowaki-dev/runtime/config";
import { markdoc } from "@nowaki-dev/markdoc";

export default defineConfig({
  plugins: [
    markdoc({
      components: "./markdoc/components.tsx",
      tags: {
        callout: { render: "Callout", attributes: { type: { type: String, matches: ["note", "warning"] } } },
      },
    }),
  ],
});
```

```tsx
// markdoc/components.tsx: capitalized `render` names are this module's exports
import type { ComponentChildren } from "preact";

export function Callout({ type = "note", children }: { type?: string; children?: ComponentChildren }) {
  return <aside class={`callout callout-${type}`}>{children}</aside>;
}
```

- Import a `.mdoc` file from a page: its default export renders the document, and it also
  exports `frontmatter` and `headings`. `.mdoc` files are not routes themselves.
- `.mdoc` files under `content/` are collection entries; `entry.render()` returns
  `{ Content, headings }`.
- Validation errors (an unknown tag, a bad attribute) fail the build, naming the file and line.
- Markdoc has no raw HTML, and the renderer drops `script`, `style`, `iframe` and similar
  elements, `on*` attributes and `javascript:` URLs.
- Without the plugin, importing a `.mdoc` file fails with a message to add it to `plugins`.

The plugin's options are in [packages/nowaki-markdoc/README.md](../../packages/nowaki-markdoc/README.md).
Working examples: `examples/hello/routes/markdoc.tsx`, `examples/hello/markdoc/`,
`examples/hello/content/docs/markdoc.mdoc`.

## Localized content

With `i18n` in nowaki.config, a first-level directory named after a locale holds that locale's
entries: `content/blog/ja/hello.md` is entry `hello` with `locale: "ja"`. An entry outside a
locale directory belongs to every locale.

`getCollection` and `getEntry` return the current request's locale (and the locale-less
entries) by default. Pass `{ locale: "ja" }` for another one, or `{ locale: "*" }` for all:

```ts
const all = await getCollection("blog", { locale: "*" });
const jaOnly = await getCollection("blog", { locale: "ja", filter: (p) => !p.data.draft });
```

In a `staticPaths` function, `getLocale()` is the locale being prerendered, so `getCollection`
returns that locale's entries. See [i18n](./i18n.md).

## Where it runs

Collections work on `nowaki dev`, `nowaki start`, every adapter and `nowaki prerender`. The
content is indexed at build time; on Cloudflare it is inlined into the Worker. In `nowaki dev`, a
change under `content/` is picked up on the next request.

## Reference

- [Runtime API](../reference/runtime.md) (`@nowaki-dev/runtime/content`: `defineCollection`,
  `getCollection`, `getEntry`, `ContentEntry`)
- [File conventions](../reference/file-conventions.md) (`content/`)
