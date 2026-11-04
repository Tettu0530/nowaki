// One blog app, written the idiomatic way in each framework. `files(opts)` returns the app's
// generated sources as { relativePath: contents }; package.json, pnpm-workspace.yaml and the
// lockfile are committed and never generated.
//
// Every app has the same pages and markup:
//   /                 root layout + latest 10 posts + `islands` interactive counters
//   /posts            every post
//   /posts/[slug]     one post, Markdown rendered on the server with `marked`, inside a nested layout
// Data is read on the server only (loader / frontmatter / server load / server component / server API).
// The home page and post pages carry a marker the dev metrics wait for.
//
// opts: { pages, islands, mode }  mode: "static" (every page prerendered) | "server" (rendered per request)

import { postsModule } from "./content.mjs";

export const MARK_HOME = "bench-marker-home";
export const MARK_POST = "bench-marker-post";

const pad = (k) => String(k).padStart(2, "0");
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const STYLE = "font-family:sans-serif;max-width:42rem;margin:0 auto;padding:2rem 1rem";

// The counter island for Nowaki and Astro (both Preact). Each island is its own module, with its
// own step, so a bundler cannot fold them into one.
const preactIsland = (k) => `import { useEffect, useState } from "preact/hooks";

export default function Island${pad(k)}({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <button type="button" data-island="${k}" data-hydrated={ready ? "" : undefined} onClick={() => setN(n + ${k})}>
      Island ${k}: {n}
    </button>
  );
}
`;

// ---------------------------------------------------------------- Nowaki
function nowaki({ pages, islands }) {
  const f = {};
  f["lib/posts.ts"] = postsModule(pages, true);
  f["routes/_layout.tsx"] = `export default function RootLayout({ children }: { children: unknown }) {
  return (
    <div style="${STYLE}">
      <header>
        <nav><a href="/">Home</a> · <a href="/posts">Posts</a></nav>
      </header>
      {children}
      <footer><p>Built for the framework comparison.</p></footer>
    </div>
  );
}
`;
  const imports = range(islands)
    .map((k) => `import Island${pad(k)} from "../islands/Island${pad(k)}.tsx";`)
    .join("\n");
  f["routes/index.tsx"] = `${imports}
import { posts, type Post } from "../lib/posts.ts";

export const title = "Home — Nowaki";

export const loader = () => ({ latest: posts.slice(0, 10) });

export default function Home({ data }: { data: { latest: Post[] } }) {
  return (
    <main>
      <h1>A blog</h1>
      <p data-bench="home">${MARK_HOME}</p>
      <section>
${range(islands)
  .map((k) => `        <Island${pad(k)} start={0} />`)
  .join("\n")}
      </section>
      <h2>Latest posts</h2>
      <ul>
        {data.latest.map((p) => (
          <li key={p.slug}>
            <a href={\`/posts/\${p.slug}\`}>{p.title}</a> <time>{p.date}</time>
            <p>{p.summary}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
  f["routes/posts/_layout.tsx"] = `export default function PostsLayout({ children }: { children: unknown }) {
  return (
    <div>
      <aside><a href="/posts">All posts</a></aside>
      {children}
    </div>
  );
}
`;
  f["routes/posts/index.tsx"] = `import { posts, type Post } from "../../lib/posts.ts";

export const title = "Posts — Nowaki";

export const loader = () => ({ posts: posts.map(({ body, ...p }) => p) });

export default function Posts({ data }: { data: { posts: Omit<Post, "body">[] } }) {
  return (
    <main>
      <h1>All posts</h1>
      <ul>
        {data.posts.map((p) => (
          <li key={p.slug}>
            <a href={\`/posts/\${p.slug}\`}>{p.title}</a> <time>{p.date}</time>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
  f["routes/posts/[slug].tsx"] = `import { marked } from "marked";
import { posts } from "../../lib/posts.ts";

type Ctx = { params: { slug: string } };

export const title = "Post — Nowaki";

export const staticPaths = () => posts.map((p) => ({ slug: p.slug }));

export const loader = (ctx: Ctx) => {
  const post = posts.find((p) => p.slug === ctx.params.slug);
  if (!post) return { post: null, html: "" };
  return { post, html: marked.parse(post.body, { async: false }) as string };
};

export default function PostPage({ data }: { data: { post: { title: string; date: string } | null; html: string } }) {
  if (!data.post) return <main><h1>Not found</h1></main>;
  return (
    <article>
      <h1>{data.post.title}</h1>
      <p data-bench="post">${MARK_POST}</p>
      <time>{data.post.date}</time>
      <div dangerouslySetInnerHTML={{ __html: data.html }} />
    </article>
  );
}
`;
  for (const k of range(islands)) f[`islands/Island${pad(k)}.tsx`] = preactIsland(k);
  return f;
}

// ---------------------------------------------------------------- Astro (Preact islands, like Nowaki)
function astro({ pages, islands, mode }) {
  const f = {};
  const server = mode === "server";
  f["astro.config.mjs"] = server
    ? `import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import preact from "@astrojs/preact";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [preact()],
});
`
    : `import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";

export default defineConfig({
  integrations: [preact()],
});
`;
  f["tsconfig.json"] = `{ "extends": "astro/tsconfigs/strict", "include": [".astro/types.d.ts", "**/*"], "exclude": ["dist"], "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" } }\n`;
  f["src/lib/posts.ts"] = postsModule(pages, true);
  f["src/layouts/Base.astro"] = `---
const { title } = Astro.props;
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>{title}</title>
  </head>
  <body>
    <div style="${STYLE}">
      <header>
        <nav><a href="/">Home</a> · <a href="/posts">Posts</a></nav>
      </header>
      <slot />
      <footer><p>Built for the framework comparison.</p></footer>
    </div>
  </body>
</html>
`;
  f["src/layouts/PostsLayout.astro"] = `---
import Base from "./Base.astro";
const { title } = Astro.props;
---

<Base title={title}>
  <div>
    <aside><a href="/posts">All posts</a></aside>
    <slot />
  </div>
</Base>
`;
  f["src/pages/index.astro"] = `---
import Base from "../layouts/Base.astro";
${range(islands)
  .map((k) => `import Island${pad(k)} from "../components/Island${pad(k)}.tsx";`)
  .join("\n")}
import { posts } from "../lib/posts";

const latest = posts.slice(0, 10);
---

<Base title="Home — Astro">
  <main>
    <h1>A blog</h1>
    <p data-bench="home">${MARK_HOME}</p>
    <section>
${range(islands)
  .map((k) => `      <Island${pad(k)} start={0} client:load />`)
  .join("\n")}
    </section>
    <h2>Latest posts</h2>
    <ul>
      {
        latest.map((p) => (
          <li>
            <a href={\`/posts/\${p.slug}\`}>{p.title}</a> <time>{p.date}</time>
            <p>{p.summary}</p>
          </li>
        ))
      }
    </ul>
  </main>
</Base>
`;
  f["src/pages/posts/index.astro"] = `---
import PostsLayout from "../../layouts/PostsLayout.astro";
import { posts } from "../../lib/posts";
---

<PostsLayout title="Posts — Astro">
  <main>
    <h1>All posts</h1>
    <ul>
      {
        posts.map((p) => (
          <li>
            <a href={\`/posts/\${p.slug}\`}>{p.title}</a> <time>{p.date}</time>
          </li>
        ))
      }
    </ul>
  </main>
</PostsLayout>
`;
  f["src/pages/posts/[slug].astro"] = `---
import { marked } from "marked";
import PostsLayout from "../../layouts/PostsLayout.astro";
import { posts } from "../../lib/posts";
${
  server
    ? `
const post = posts.find((p) => p.slug === Astro.params.slug);
if (!post) return new Response("Not found", { status: 404 });`
    : `
export function getStaticPaths() {
  return posts.map((post) => ({ params: { slug: post.slug }, props: { post } }));
}

const { post } = Astro.props;`
}
const html = marked.parse(post.body, { async: false }) as string;
---

<PostsLayout title="Post — Astro">
  <article>
    <h1>{post.title}</h1>
    <p data-bench="post">${MARK_POST}</p>
    <time>{post.date}</time>
    <div set:html={html} />
  </article>
</PostsLayout>
`;
  for (const k of range(islands)) f[`src/components/Island${pad(k)}.tsx`] = preactIsland(k);
  return f;
}

// ---------------------------------------------------------------- SvelteKit (Svelte 5)
function sveltekit({ pages, islands, mode }) {
  const f = {};
  const server = mode === "server";
  f["vite.config.js"] = `import adapter from "@sveltejs/adapter-${server ? "node" : "static"}";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] });
`;
  f["src/app.html"] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    %sveltekit.head%
  </head>
  <body>
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`;
  f["src/lib/server/posts.js"] = postsModule(pages);
  if (!server) f["src/routes/+layout.js"] = "export const prerender = true;\n";
  f["src/routes/+layout.svelte"] = `<script>
  let { children } = $props();
</script>

<div style="${STYLE}">
  <header>
    <nav><a href="/">Home</a> · <a href="/posts">Posts</a></nav>
  </header>
  {@render children()}
  <footer><p>Built for the framework comparison.</p></footer>
</div>
`;
  f["src/routes/+page.server.js"] = `import { posts } from "#lib/server/posts.js";

export function load() {
  return { latest: posts.slice(0, 10) };
}
`;
  f["src/routes/+page.svelte"] = `<script>
${range(islands)
  .map((k) => `  import Island${pad(k)} from "#lib/Island${pad(k)}.svelte";`)
  .join("\n")}
  let { data } = $props();
</script>

<svelte:head><title>Home — SvelteKit</title></svelte:head>

<main>
  <h1>A blog</h1>
  <p data-bench="home">${MARK_HOME}</p>
  <section>
${range(islands)
  .map((k) => `    <Island${pad(k)} start={0} />`)
  .join("\n")}
  </section>
  <h2>Latest posts</h2>
  <ul>
    {#each data.latest as p (p.slug)}
      <li>
        <a href={\`/posts/\${p.slug}\`}>{p.title}</a> <time>{p.date}</time>
        <p>{p.summary}</p>
      </li>
    {/each}
  </ul>
</main>
`;
  f["src/routes/posts/+layout.svelte"] = `<script>
  let { children } = $props();
</script>

<div>
  <aside><a href="/posts">All posts</a></aside>
  {@render children()}
</div>
`;
  f["src/routes/posts/+page.server.js"] = `import { posts } from "#lib/server/posts.js";

export function load() {
  return { posts: posts.map(({ body, ...p }) => p) };
}
`;
  f["src/routes/posts/+page.svelte"] = `<script>
  let { data } = $props();
</script>

<svelte:head><title>Posts — SvelteKit</title></svelte:head>

<main>
  <h1>All posts</h1>
  <ul>
    {#each data.posts as p (p.slug)}
      <li><a href={\`/posts/\${p.slug}\`}>{p.title}</a> <time>{p.date}</time></li>
    {/each}
  </ul>
</main>
`;
  f["src/routes/posts/[slug]/+page.server.js"] = `import { error } from "@sveltejs/kit";
import { marked } from "marked";
import { posts } from "#lib/server/posts.js";
${server ? "" : "\nexport const entries = () => posts.map((p) => ({ slug: p.slug }));\n"}
export function load({ params }) {
  const post = posts.find((p) => p.slug === params.slug);
  if (!post) error(404, "Not found");
  return { title: post.title, date: post.date, html: marked.parse(post.body, { async: false }) };
}
`;
  f["src/routes/posts/[slug]/+page.svelte"] = `<script>
  let { data } = $props();
</script>

<svelte:head><title>Post — SvelteKit</title></svelte:head>

<article>
  <h1>{data.title}</h1>
  <p data-bench="post">${MARK_POST}</p>
  <time>{data.date}</time>
  <div>{@html data.html}</div>
</article>
`;
  for (const k of range(islands)) {
    f[`src/lib/Island${pad(k)}.svelte`] = `<script>
  let { start = 0 } = $props();
  let n = $state(start);
  let ready = $state(false);
  $effect(() => {
    ready = true;
  });
</script>

<button type="button" data-island="${k}" data-hydrated={ready ? "" : undefined} onclick={() => (n += ${k})}>
  Island ${k}: {n}
</button>
`;
  }
  return f;
}

// ---------------------------------------------------------------- Next.js (App Router, React 19)
function next({ pages, islands, mode }) {
  const f = {};
  const server = mode === "server";
  const dynamic = server ? `\nexport const dynamic = "force-dynamic";\n` : "";
  f["next.config.mjs"] = server
    ? "/** @type {import('next').NextConfig} */\nexport default {};\n"
    : "/** @type {import('next').NextConfig} */\nexport default { output: \"export\" };\n";
  f["next-env.d.ts"] = '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n';
  f["tsconfig.json"] = `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: false,
        noEmit: true,
        incremental: true,
        module: "esnext",
        esModuleInterop: true,
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        plugins: [{ name: "next" }],
      },
      include: ["next-env.d.ts", ".next/types/**/*.ts", "**/*.ts", "**/*.tsx", ".next/dev/types/**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2,
  )}\n`;
  f["lib/posts.ts"] = postsModule(pages, true);
  f["app/layout.tsx"] = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div style={{ fontFamily: "sans-serif", maxWidth: "42rem", margin: "0 auto", padding: "2rem 1rem" }}>
          <header>
            <nav><a href="/">Home</a> · <a href="/posts">Posts</a></nav>
          </header>
          {children}
          <footer><p>Built for the framework comparison.</p></footer>
        </div>
      </body>
    </html>
  );
}
`;
  f["app/page.tsx"] = `import Link from "next/link";
${range(islands)
  .map((k) => `import Island${pad(k)} from "../components/Island${pad(k)}";`)
  .join("\n")}
import { posts } from "../lib/posts";

export const metadata = { title: "Home — Next" };
${dynamic}
export default function Home() {
  const latest = posts.slice(0, 10);
  return (
    <main>
      <h1>A blog</h1>
      <p data-bench="home">${MARK_HOME}</p>
      <section>
${range(islands)
  .map((k) => `        <Island${pad(k)} start={0} />`)
  .join("\n")}
      </section>
      <h2>Latest posts</h2>
      <ul>
        {latest.map((p) => (
          <li key={p.slug}>
            <Link href={\`/posts/\${p.slug}\`}>{p.title}</Link> <time>{p.date}</time>
            <p>{p.summary}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
  f["app/posts/layout.tsx"] = `import Link from "next/link";

export default function PostsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <aside><Link href="/posts">All posts</Link></aside>
      {children}
    </div>
  );
}
`;
  f["app/posts/page.tsx"] = `import Link from "next/link";
import { posts } from "../../lib/posts";

export const metadata = { title: "Posts — Next" };
${dynamic}
export default function Posts() {
  return (
    <main>
      <h1>All posts</h1>
      <ul>
        {posts.map((p) => (
          <li key={p.slug}>
            <Link href={\`/posts/\${p.slug}\`}>{p.title}</Link> <time>{p.date}</time>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
  f["app/posts/[slug]/page.tsx"] = `import { marked } from "marked";
import { notFound } from "next/navigation";
import { posts } from "../../../lib/posts";

export const metadata = { title: "Post — Next" };
${
  server
    ? dynamic
    : `
export const dynamicParams = false;

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}
`
}
export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = posts.find((p) => p.slug === slug);
  if (!post) notFound();
  const html = marked.parse(post.body, { async: false }) as string;
  return (
    <article>
      <h1>{post.title}</h1>
      <p data-bench="post">${MARK_POST}</p>
      <time>{post.date}</time>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
`;
  for (const k of range(islands)) {
    f[`components/Island${pad(k)}.tsx`] = `"use client";

import { useEffect, useState } from "react";

export default function Island${pad(k)}({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <button type="button" data-island="${k}" data-hydrated={ready ? "" : undefined} onClick={() => setN(n + ${k})}>
      Island ${k}: {n}
    </button>
  );
}
`;
  }
  return f;
}

// ---------------------------------------------------------------- Nuxt (Vue 3, data through server/api + useFetch)
function nuxt({ pages, islands, mode }) {
  const f = {};
  f["nuxt.config.ts"] = `export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  devtools: { enabled: false },
  telemetry: false,${mode === "static" ? `\n  nitro: { prerender: { crawlLinks: true, routes: ["/"] } },` : ""}
});
`;
  f["tsconfig.json"] = `{ "files": [], "references": [{ "path": "./.nuxt/tsconfig.app.json" }, { "path": "./.nuxt/tsconfig.server.json" }, { "path": "./.nuxt/tsconfig.shared.json" }, { "path": "./.nuxt/tsconfig.node.json" }] }\n`;
  f["server/data/posts.ts"] = postsModule(pages, true);
  f["server/api/posts.get.ts"] = `import { posts } from "../data/posts";

export default defineEventHandler((event) => {
  const limit = Number(getQuery(event).limit ?? 0);
  const list = posts.map(({ body, ...p }) => p);
  return limit ? list.slice(0, limit) : list;
});
`;
  f["server/api/posts/[slug].get.ts"] = `import { marked } from "marked";
import { posts } from "../../data/posts";

export default defineEventHandler((event) => {
  const post = posts.find((p) => p.slug === getRouterParam(event, "slug"));
  if (!post) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { title: post.title, date: post.date, html: marked.parse(post.body, { async: false }) as string };
});
`;
  f["app/app.vue"] = `<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
`;
  f["app/layouts/default.vue"] = `<template>
  <div style="${STYLE}">
    <header>
      <nav><NuxtLink to="/">Home</NuxtLink> · <NuxtLink to="/posts">Posts</NuxtLink></nav>
    </header>
    <slot />
    <footer><p>Built for the framework comparison.</p></footer>
  </div>
</template>
`;
  f["app/pages/index.vue"] = `<script setup lang="ts">
useHead({ title: "Home — Nuxt" });
const { data: latest } = await useFetch("/api/posts", { query: { limit: 10 } });
</script>

<template>
  <main>
    <h1>A blog</h1>
    <p data-bench="home">${MARK_HOME}</p>
    <section>
${range(islands)
  .map((k) => `      <Island${pad(k)} :start="0" />`)
  .join("\n")}
    </section>
    <h2>Latest posts</h2>
    <ul>
      <li v-for="p in latest" :key="p.slug">
        <NuxtLink :to="\`/posts/\${p.slug}\`">{{ p.title }}</NuxtLink> <time>{{ p.date }}</time>
        <p>{{ p.summary }}</p>
      </li>
    </ul>
  </main>
</template>
`;
  f["app/pages/posts.vue"] = `<template>
  <div>
    <aside><NuxtLink to="/posts">All posts</NuxtLink></aside>
    <NuxtPage />
  </div>
</template>
`;
  f["app/pages/posts/index.vue"] = `<script setup lang="ts">
useHead({ title: "Posts — Nuxt" });
const { data: posts } = await useFetch("/api/posts");
</script>

<template>
  <main>
    <h1>All posts</h1>
    <ul>
      <li v-for="p in posts" :key="p.slug">
        <NuxtLink :to="\`/posts/\${p.slug}\`">{{ p.title }}</NuxtLink> <time>{{ p.date }}</time>
      </li>
    </ul>
  </main>
</template>
`;
  f["app/pages/posts/[slug].vue"] = `<script setup lang="ts">
useHead({ title: "Post — Nuxt" });
const route = useRoute();
const { data: post } = await useFetch(\`/api/posts/\${route.params.slug}\`);
if (!post.value) throw createError({ statusCode: 404, statusMessage: "Not found", fatal: true });
</script>

<template>
  <article v-if="post">
    <h1>{{ post.title }}</h1>
    <p data-bench="post">${MARK_POST}</p>
    <time>{{ post.date }}</time>
    <div v-html="post.html" />
  </article>
</template>
`;
  for (const k of range(islands)) {
    f[`app/components/Island${pad(k)}.vue`] = `<script setup lang="ts">
const props = withDefaults(defineProps<{ start?: number }>(), { start: 0 });
const n = ref(props.start);
const ready = ref(false);
onMounted(() => {
  ready.value = true;
});
</script>

<template>
  <button type="button" data-island="${k}" :data-hydrated="ready ? '' : undefined" @click="n += ${k}">
    Island ${k}: {{ n }}
  </button>
</template>
`;
  }
  return f;
}

export const TEMPLATES = { nowaki, astro, sveltekit, next, nuxt };
