// Page URLs from the route table: static routes give one URL, dynamic routes one per
// `staticPaths` entry (routes without it are skipped). Used for the ISR warm-up (`isrUrls`) and the
// generated sitemap.xml (`sitemapUrls`).

import { localePathFor } from "./i18n.mjs";
import { runWithLocale } from "./i18n-context.mjs";

/// Pages whose module passes `keep(mod)`, at most `max`.
export async function pageUrls(env, { keep, max = Infinity, version, label = "page list" } = {}) {
  const { routes } = await env.routeTable(version);
  const urls = new Set();
  for (const route of routes) {
    if (route.isApi || urls.size >= max) continue;
    let mod;
    try {
      mod = await env.importModule(route.file, version);
    } catch {
      continue; // the first real request reports it
    }
    if (!keep(mod)) continue;
    if (env.i18n) {
      await localeUrls(env.i18n, route, mod, urls, max, label);
      continue;
    }
    if (!route.segments.some((s) => s.param)) {
      urls.add(urlOf(route, {}));
      continue;
    }
    let list = mod.staticPaths;
    try {
      if (typeof list === "function") list = await list({});
    } catch (err) {
      console.warn(`[nowaki] ${label}: staticPaths of ${route.file} failed: ${err?.message ?? err}`);
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const params of list) {
      const url = urlOf(route, params ?? {});
      if (url) urls.add(url);
      if (urls.size >= max) break;
    }
  }
  return [...urls];
}

// i18n: a page's URL in every locale (`/about`, `/ja/about`). A dynamic route's staticPaths runs
// once per locale, given `{ locale }` and with it as getLocale() (getCollection returns that
// locale's entries).
async function localeUrls(i18n, route, mod, urls, max, label) {
  const dynamic = route.segments.some((s) => s.param);
  for (const locale of i18n.locales) {
    let list = dynamic ? mod.staticPaths : [{}];
    try {
      if (typeof list === "function") list = await runWithLocale({ locale, i18n }, () => list({ locale }));
    } catch (err) {
      console.warn(`[nowaki] ${label}: staticPaths of ${route.file} (${locale}) failed: ${err?.message ?? err}`);
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const params of list) {
      const url = urlOf(route, params ?? {});
      if (url) urls.add(localePathFor(i18n, url, locale));
      if (urls.size >= max) return;
    }
  }
}

/// The URLs of ISR pages (`export const revalidate` > 0): `nowaki start` renders each one once at
/// startup, so the first visitor already gets a cached page from the Rust front.
export function isrUrls(env, { max = 1024 } = {}) {
  return pageUrls(env, {
    max,
    label: "ISR warm-up",
    keep: (mod) => {
      const r = Number(mod?.revalidate);
      return Number.isFinite(r) && r > 0;
    },
  });
}

/// The URLs the generated sitemap.xml lists: every page, except ones that opt out with
/// `export const sitemap = false` or a static `meta.robots` of noindex.
export function sitemapUrls(env, version) {
  return pageUrls(env, {
    version,
    label: "sitemap.xml",
    keep: (mod) => {
      if (mod?.sitemap === false || typeof mod?.default !== "function") return false;
      const robots = mod?.meta && typeof mod.meta === "object" ? mod.meta.robots : undefined;
      if (typeof robots === "string" && /noindex/i.test(robots)) return false;
      if (robots && typeof robots === "object" && robots.index === false) return false;
      return true;
    },
  });
}

function urlOf(route, params) {
  const out = [];
  for (const seg of route.segments) {
    if (seg.lit !== undefined) {
      out.push(seg.lit);
      continue;
    }
    const value = params[seg.param];
    const parts = seg.rest ? (Array.isArray(value) ? value : [value]) : [value];
    for (const part of parts) {
      const s = part === undefined || part === null ? "" : String(part);
      if (s === "" || s === "." || s === ".." || s.includes("/")) return null;
      out.push(encodeURIComponent(s) + (seg.suffix ?? ""));
    }
  }
  return "/" + out.join("/");
}
