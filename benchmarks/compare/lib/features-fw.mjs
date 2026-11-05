// The per-framework files for the parts described in features.mjs. Each function returns
// { relativePath: contents } that templates.mjs merges into the app.

import {
  CONTACT_SCHEMA,
  GLOBAL_CSS,
  MARK_STATS,
  SEARCH_LIB,
  TABLE_CSS,
  contactBody,
  preactIslands,
} from "./features.mjs";

const NAV = [
  ["/", "Home"],
  ["/posts", "Posts"],
  ["/stats", "Stats"],
  ["/contact", "Contact"],
];

// Plain <a> nav links; `link(href, label)` lets a framework use its own link component.
export const navLinks = (link = (href, label) => `<a href="${href}">${label}</a>`) =>
  NAV.map(([href, label]) => link(href, label)).join(" · ");

const indent = (text, n) =>
  text
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");

const STATUS_JSX = (sent, error) => `{${sent} && <p class="notice">Thanks, your message was sent.</p>}
{${error} && <p class="notice" data-kind="error">Please check the form and try again.</p>}`;

// ---------------------------------------------------------------- Nowaki
export function nowakiFeatures({ mode }) {
  const server = mode === "server";
  const f = {};
  // As nowaki.dev itself does: the CSS as a string module, and a shared `head` every route
  // exports (layouts cannot add to <head>). A `.css` import in a route resolves to an empty
  // module in the server build, so it cannot be used for this.
  f["lib/global-css.ts"] = `export const GLOBAL_CSS = ${JSON.stringify(GLOBAL_CSS)};\n`;
  f["lib/head.ts"] = `import { GLOBAL_CSS } from "./global-css.ts";

export const HEAD = \`<style>\${GLOBAL_CSS}</style>\`;
`;
  f["lib/search.ts"] = SEARCH_LIB;
  f["lib/contact.ts"] = CONTACT_SCHEMA;
  for (const [name, src] of Object.entries(preactIslands('import styles from "./SortTable.module.css";'))) f[`islands/${name}`] = src;
  f["islands/SortTable.module.css"] = TABLE_CSS;
  f["routes/stats.tsx"] = `import SortTable from "../islands/SortTable.tsx";
import { HEAD } from "../lib/head.ts";
import { posts } from "../lib/posts.ts";
import { statsRows } from "../lib/search.ts";

export const title = "Stats — Nowaki";
export const head = HEAD;

export const loader = () => ({ rows: statsRows(posts) });

export default function Stats({ data }: { data: { rows: ReturnType<typeof statsRows> } }) {
  return (
    <main>
      <h1>Stats</h1>
      <p data-bench="stats">${MARK_STATS}</p>
      <SortTable rows={data.rows} />
    </main>
  );
}
`;
  f["routes/contact.tsx"] = `import type { LoaderContext } from "@nowaki-dev/runtime";
${server ? 'import { Contact } from "../lib/contact.ts";\n' : ""}import { HEAD } from "../lib/head.ts";

export const title = "Contact — Nowaki";
export const head = HEAD;

export const loader = ({ url }: LoaderContext) => ({
  sent: url.searchParams.has("sent"),
  error: url.searchParams.has("error"),
});
${
  server
    ? `
export async function action(ctx: LoaderContext) {
  const form = await ctx.formData();
  const ok = Contact.safeParse(Object.fromEntries(form)).success;
  return ctx.redirect(ok ? "/contact?sent=1" : "/contact?error=1");
}
`
    : ""
}
export default function ContactPage({ data }: { data: { sent: boolean; error: boolean } }) {
  return (
    <main>
${indent(contactBody({ status: STATUS_JSX("data.sent", "data.error"), action: null }), 6)}
    </main>
  );
}
`;
  f["routes/api/search.ts"] = `import type { LoaderContext } from "@nowaki-dev/runtime";
import { posts } from "../../lib/posts.ts";
import { search } from "../../lib/search.ts";

export const GET = (ctx: LoaderContext & { json: (v: unknown) => unknown }) =>
  ctx.json(search(posts, ctx.url.searchParams.get("q")));
`;
  return f;
}

// ---------------------------------------------------------------- Astro
export function astroFeatures({ mode }) {
  const server = mode === "server";
  const f = {};
  f["src/styles/global.css"] = GLOBAL_CSS;
  f["src/lib/search.ts"] = SEARCH_LIB;
  f["src/lib/contact.ts"] = CONTACT_SCHEMA;
  for (const [name, src] of Object.entries(preactIslands('import styles from "./SortTable.module.css";'))) f[`src/components/${name}`] = src;
  f["src/components/SortTable.module.css"] = TABLE_CSS;
  f["src/pages/stats.astro"] = `---
import Base from "../layouts/Base.astro";
import SortTable from "../components/SortTable.tsx";
import { posts } from "../lib/posts";
import { statsRows } from "../lib/search";

const rows = statsRows(posts);
---

<Base title="Stats — Astro">
  <main>
    <h1>Stats</h1>
    <p data-bench="stats">${MARK_STATS}</p>
    <SortTable rows={rows} client:load />
  </main>
</Base>
`;
  // A plain form POST is handled in the page's frontmatter (Astro's documented pattern for
  // HTML forms; Actions would add a client runtime for no benefit here).
  f["src/pages/contact.astro"] = `---
import Base from "../layouts/Base.astro";
${
  server
    ? `import { Contact } from "../lib/contact";

if (Astro.request.method === "POST") {
  const form = await Astro.request.formData();
  const ok = Contact.safeParse(Object.fromEntries(form)).success;
  return Astro.redirect(ok ? "/contact?sent=1" : "/contact?error=1", 303);
}
const sent = Astro.url.searchParams.has("sent");
const error = Astro.url.searchParams.has("error");`
    : `const sent = false;
const error = false;`
}
---

<Base title="Contact — Astro">
  <main>
${indent(contactBody({ status: STATUS_JSX("sent", "error"), action: null }), 4)}
  </main>
</Base>
`;
  f["src/pages/api/search.ts"] = `import type { APIRoute } from "astro";
import { posts } from "../../lib/posts";
import { search } from "../../lib/search";

export const GET: APIRoute = (${server ? "{ url }" : ""}) =>
  new Response(JSON.stringify(search(posts, ${server ? 'url.searchParams.get("q")' : '""'})), {
    headers: { "content-type": "application/json" },
  });
`;
  return f;
}

// ---------------------------------------------------------------- SvelteKit (Svelte 5 components)
export function sveltekitFeatures({ mode }) {
  const server = mode === "server";
  const f = {};
  f["src/app.css"] = GLOBAL_CSS;
  f["src/lib/server/search.js"] = SEARCH_LIB;
  f["src/lib/server/contact.js"] = CONTACT_SCHEMA;
  f["src/lib/ThemeToggle.svelte"] = `<script>
  import { onMount } from "svelte";

  let theme = $state("light");
  let ready = $state(false);
  onMount(() => {
    const saved = localStorage.getItem("theme") ?? "light";
    document.documentElement.dataset.theme = saved;
    theme = saved;
    ready = true;
  });
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    theme = next;
  }
</script>

<button type="button" data-island="theme" data-hydrated={ready ? "" : undefined} onclick={toggle}>
  {theme === "dark" ? "Light" : "Dark"} theme
</button>
`;
  f["src/lib/Search.svelte"] = `<script>
  import { onMount } from "svelte";

  let q = $state("");
  let hits = $state([]);
  let ready = $state(false);
  onMount(() => (ready = true));
  $effect(() => {
    const query = q;
    if (!query) {
      hits = [];
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(\`/api/search?q=\${encodeURIComponent(query)}\`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((h) => (hits = h))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  });
</script>

<div data-island="search" data-hydrated={ready ? "" : undefined}>
  <input type="search" placeholder="Search titles" bind:value={q} />
  <ul class="results">
    {#each hits as h (h.slug)}
      <li><a href={\`/posts/\${h.slug}\`}>{h.title}</a></li>
    {/each}
  </ul>
</div>
`;
  f["src/lib/SortTable.svelte"] = `<script>
  import { onMount } from "svelte";

  const COLUMNS = [["title", "Title"], ["date", "Date"], ["words", "Words"]];
  let { rows } = $props();
  let key = $state("date");
  let asc = $state(false);
  let ready = $state(false);
  onMount(() => (ready = true));
  const sorted = $derived([...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (asc ? 1 : -1)));
  function sortBy(k) {
    if (k === key) asc = !asc;
    else {
      key = k;
      asc = true;
    }
  }
</script>

<table class="table" data-island="table" data-hydrated={ready ? "" : undefined}>
  <thead>
    <tr>
      {#each COLUMNS as [k, label] (k)}
        <th class:num={k === "words"}>
          <button type="button" class:active={k === key} onclick={() => sortBy(k)}>
            {label} {k === key ? (asc ? "↑" : "↓") : ""}
          </button>
        </th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each sorted as r (r.slug)}
      <tr>
        <td><a href={\`/posts/\${r.slug}\`}>{r.title}</a></td>
        <td><time>{r.date}</time></td>
        <td class="num">{r.words}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
${indent(TABLE_CSS, 2)}
</style>
`;
  f["src/routes/stats/+page.server.js"] = `import { posts } from "#lib/server/posts.js";
import { statsRows } from "#lib/server/search.js";

export function load() {
  return { rows: statsRows(posts) };
}
`;
  f["src/routes/stats/+page.svelte"] = `<script>
  import SortTable from "#lib/SortTable.svelte";

  let { data } = $props();
</script>

<svelte:head><title>Stats — SvelteKit</title></svelte:head>

<main>
  <h1>Stats</h1>
  <p data-bench="stats">${MARK_STATS}</p>
  <SortTable rows={data.rows} />
</main>
`;
  // Static mode: a prerendered page cannot read url.searchParams or have actions.
  f["src/routes/contact/+page.server.js"] = server
    ? `import { redirect } from "@sveltejs/kit";
import { Contact } from "#lib/server/contact.js";

export function load({ url }) {
  return { sent: url.searchParams.has("sent"), error: url.searchParams.has("error") };
}

export const actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    const ok = Contact.safeParse(Object.fromEntries(form)).success;
    redirect(303, ok ? "/contact?sent=1" : "/contact?error=1");
  },
};
`
    : `export function load() {
  return { sent: false, error: false };
}
`;
  f["src/routes/contact/+page.svelte"] = `<script>
  let { data } = $props();
</script>

<svelte:head><title>Contact — SvelteKit</title></svelte:head>

<main>
${indent(
  contactBody({
    status: `{#if data.sent}<p class="notice">Thanks, your message was sent.</p>{/if}
{#if data.error}<p class="notice" data-kind="error">Please check the form and try again.</p>{/if}`,
    action: null,
  }),
  2,
)}
</main>
`;
  f["src/routes/api/search/+server.js"] = server
    ? `import { json } from "@sveltejs/kit";
import { posts } from "#lib/server/posts.js";
import { search } from "#lib/server/search.js";

export function GET({ url }) {
  return json(search(posts, url.searchParams.get("q")));
}
`
    : `import { json } from "@sveltejs/kit";
import { posts } from "#lib/server/posts.js";
import { search } from "#lib/server/search.js";

export const prerender = true;

export function GET() {
  return json(search(posts, ""));
}
`;
  return f;
}

// ---------------------------------------------------------------- Next.js (client components)
const REACT_FORM = (action) => `<form${action}>
  <label htmlFor="name">Name</label>
  <input id="name" name="name" required maxLength={80} />
  <label htmlFor="email">Email</label>
  <input id="email" name="email" type="email" required />
  <label htmlFor="message">Message</label>
  <textarea id="message" name="message" required minLength={10} maxLength={2000} />
  <button type="submit">Send</button>
</form>`;

export function nextFeatures({ mode }) {
  const server = mode === "server";
  const f = {};
  f["app/globals.css"] = GLOBAL_CSS;
  f["lib/search.ts"] = SEARCH_LIB;
  f["lib/contact.ts"] = CONTACT_SCHEMA;
  // The Preact islands, as React client components.
  const islands = preactIslands('import styles from "./SortTable.module.css";');
  const toReact = (src) =>
    `"use client";\n\n${src
      .replace('from "preact/hooks"', 'from "react"')
      .replace(/\bclass=/g, "className=")
      .replace("onInput={(e) => setQ((e.target as HTMLInputElement).value)}", "onChange={(e) => setQ(e.target.value)}")
      .replace("<a href={`/posts/${h.slug}`}>{h.title}</a>", "<Link href={`/posts/${h.slug}`}>{h.title}</Link>")
      .replace("<a href={`/posts/${r.slug}`}>{r.title}</a>", "<Link href={`/posts/${r.slug}`}>{r.title}</Link>")}`;
  f["components/ThemeToggle.tsx"] = toReact(islands["ThemeToggle.tsx"]);
  f["components/Search.tsx"] = toReact(islands["Search.tsx"]).replace('import { useEffect, useState } from "react";', 'import Link from "next/link";\nimport { useEffect, useState } from "react";');
  f["components/SortTable.tsx"] = toReact(islands["SortTable.tsx"]).replace('import { useEffect, useState } from "react";', 'import Link from "next/link";\nimport { useEffect, useState } from "react";');
  f["components/SortTable.module.css"] = TABLE_CSS;
  f["app/stats/page.tsx"] = `import SortTable from "../../components/SortTable";
import { posts } from "../../lib/posts";
import { statsRows } from "../../lib/search";

export const metadata = { title: "Stats — Next" };
${server ? '\nexport const dynamic = "force-dynamic";\n' : ""}
export default function Stats() {
  return (
    <main>
      <h1>Stats</h1>
      <p data-bench="stats">${MARK_STATS}</p>
      <SortTable rows={statsRows(posts)} />
    </main>
  );
}
`;
  f["app/contact/page.tsx"] = server
    ? `import { redirect } from "next/navigation";
import { Contact } from "../../lib/contact";

export const metadata = { title: "Contact — Next" };
export const dynamic = "force-dynamic";

async function submit(form: FormData) {
  "use server";
  const ok = Contact.safeParse(Object.fromEntries(form)).success;
  redirect(ok ? "/contact?sent=1" : "/contact?error=1");
}

export default async function ContactPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const query = await searchParams;
  return (
    <main>
      <h1>Contact</h1>
      <p data-bench="contact">bench-marker-contact</p>
      {"sent" in query && <p className="notice">Thanks, your message was sent.</p>}
      {"error" in query && <p className="notice" data-kind="error">Please check the form and try again.</p>}
${indent(REACT_FORM(" action={submit}"), 6)}
    </main>
  );
}
`
    : `export const metadata = { title: "Contact — Next" };

// output: "export" has no Server Actions; the form renders without a handler.
export default function ContactPage() {
  return (
    <main>
      <h1>Contact</h1>
      <p data-bench="contact">bench-marker-contact</p>
${indent(REACT_FORM(' method="post"'), 6)}
    </main>
  );
}
`;
  f["app/api/search/route.ts"] = server
    ? `import { posts } from "../../../lib/posts";
import { search } from "../../../lib/search";

export function GET(request: Request) {
  return Response.json(search(posts, new URL(request.url).searchParams.get("q")));
}
`
    : `import { posts } from "../../../lib/posts";
import { search } from "../../../lib/search";

export const dynamic = "force-static";

export function GET() {
  return Response.json(search(posts, ""));
}
`;
  return f;
}

// ---------------------------------------------------------------- Nuxt (Vue SFCs, data via server/api)
export function nuxtFeatures({ mode }) {
  const server = mode === "server";
  const f = {};
  f["app/assets/global.css"] = GLOBAL_CSS;
  f["server/lib/search.ts"] = SEARCH_LIB;
  f["server/lib/contact.ts"] = CONTACT_SCHEMA;
  f["app/components/ThemeToggle.vue"] = `<script setup lang="ts">
const theme = ref("light");
const ready = ref(false);
onMounted(() => {
  const saved = localStorage.getItem("theme") ?? "light";
  document.documentElement.dataset.theme = saved;
  theme.value = saved;
  ready.value = true;
});
function toggle() {
  const next = theme.value === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
  theme.value = next;
}
</script>

<template>
  <button type="button" data-island="theme" :data-hydrated="ready ? '' : undefined" @click="toggle">
    {{ theme === "dark" ? "Light" : "Dark" }} theme
  </button>
</template>
`;
  f["app/components/Search.vue"] = `<script setup lang="ts">
const q = ref("");
const hits = ref<{ slug: string; title: string }[]>([]);
const ready = ref(false);
onMounted(() => (ready.value = true));
let timer: ReturnType<typeof setTimeout> | undefined;
let ctrl: AbortController | undefined;
watch(q, (query) => {
  clearTimeout(timer);
  ctrl?.abort();
  if (!query) {
    hits.value = [];
    return;
  }
  timer = setTimeout(() => {
    ctrl = new AbortController();
    fetch(\`/api/search?q=\${encodeURIComponent(query)}\`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((h) => (hits.value = h))
      .catch(() => {});
  }, 150);
});
</script>

<template>
  <div data-island="search" :data-hydrated="ready ? '' : undefined">
    <input v-model="q" type="search" placeholder="Search titles" />
    <ul class="results">
      <li v-for="h in hits" :key="h.slug">
        <NuxtLink :to="\`/posts/\${h.slug}\`">{{ h.title }}</NuxtLink>
      </li>
    </ul>
  </div>
</template>
`;
  f["app/components/SortTable.vue"] = `<script setup lang="ts">
type Row = { slug: string; title: string; date: string; words: number };
type Key = keyof Row;
const COLUMNS: [Key, string][] = [["title", "Title"], ["date", "Date"], ["words", "Words"]];
const props = defineProps<{ rows: Row[] }>();
const key = ref<Key>("date");
const asc = ref(false);
const ready = ref(false);
onMounted(() => (ready.value = true));
const sorted = computed(() =>
  [...props.rows].sort((a, b) => (a[key.value] < b[key.value] ? -1 : a[key.value] > b[key.value] ? 1 : 0) * (asc.value ? 1 : -1)),
);
function sortBy(k: Key) {
  if (k === key.value) asc.value = !asc.value;
  else {
    key.value = k;
    asc.value = true;
  }
}
</script>

<template>
  <table class="table" data-island="table" :data-hydrated="ready ? '' : undefined">
    <thead>
      <tr>
        <th v-for="[k, label] in COLUMNS" :key="k" :class="{ num: k === 'words' }">
          <button type="button" :class="{ active: k === key }" @click="sortBy(k)">
            {{ label }} {{ k === key ? (asc ? "↑" : "↓") : "" }}
          </button>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="r in sorted" :key="r.slug">
        <td><NuxtLink :to="\`/posts/\${r.slug}\`">{{ r.title }}</NuxtLink></td>
        <td><time>{{ r.date }}</time></td>
        <td class="num">{{ r.words }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
${TABLE_CSS}</style>
`;
  f["server/api/search.get.ts"] = `import { posts } from "../data/posts";
import { search } from "../lib/search";

export default defineEventHandler((event) => search(posts, getQuery(event).q));
`;
  f["server/api/stats.get.ts"] = `import { posts } from "../data/posts";
import { statsRows } from "../lib/search";

export default defineEventHandler(() => statsRows(posts));
`;
  if (server) {
    f["server/api/contact.post.ts"] = `import { Contact } from "../lib/contact";

export default defineEventHandler(async (event) => {
  const form = await readFormData(event);
  const ok = Contact.safeParse(Object.fromEntries(form)).success;
  return sendRedirect(event, ok ? "/contact?sent=1" : "/contact?error=1", 303);
});
`;
  }
  f["app/pages/stats.vue"] = `<script setup lang="ts">
useHead({ title: "Stats — Nuxt" });
const { data: rows } = await useFetch("/api/stats");
</script>

<template>
  <main>
    <h1>Stats</h1>
    <p data-bench="stats">${MARK_STATS}</p>
    <SortTable :rows="rows ?? []" />
  </main>
</template>
`;
  f["app/pages/contact.vue"] = `<script setup lang="ts">
useHead({ title: "Contact — Nuxt" });
const route = useRoute();
const sent = computed(() => "sent" in route.query);
const error = computed(() => "error" in route.query);
</script>

<template>
  <main>
${indent(
  contactBody({
    status: `<p v-if="sent" class="notice">Thanks, your message was sent.</p>
<p v-if="error" class="notice" data-kind="error">Please check the form and try again.</p>`,
    action: server ? "/api/contact" : null,
  }),
  4,
)}
  </main>
</template>
`;
  return f;
}
