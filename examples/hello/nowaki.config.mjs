// Nowaki config. `plugins` can have a transform hook (transform) and virtual modules (resolveId/load).
//   transform(code, id)        — called on transformable source before oxc runs
//   resolveId(source, importer) — claims a specifier and returns an id (called only when normal resolution fails)
//   load(id)                    — returns the source for that id (a virtual module not on disk)
// Return null/undefined for no change (fast path).
import { markdoc } from "@nowaki-dev/markdoc";

export default {
  // The site's URL: absolute canonical / Open Graph links, the generated sitemap.xml and
  // robots.txt, and `ctx.site` (NOWAKI_SITE overrides it at runtime).
  site: "https://hello.nowaki.dev",
  // Self-hosted fonts: a local file here (OFL, see fonts/OFL.txt); `provider: "google"` downloads
  // Google Fonts at build time instead. Each gets a size-adjusted fallback and a CSS variable.
  fonts: [
    { family: "Atkinson Hyperlegible", src: "./fonts/atkinson-hyperlegible-400.ttf", weight: 400, variable: "--font-body" },
  ],
  // Redirects, rewrites, and headers: applied by every server (dev, start, adapters, static
  // `_redirects` / `_headers`) before routes and public/ files. Sources use the route syntax; a
  // capture is percent-encoded so it can't leave the site. Config headers attach to every matching
  // response (pages, assets, redirects, 404s) unless the route set the same header.
  redirects: [
    { source: "/old-docs/[...rest]", destination: "/[...rest]", permanent: true },
    { source: "/go/[to]", destination: "/[to]" },
  ],
  rewrites: [{ source: "/p/[slug]", destination: "/blog/[slug]" }],
  headers: [
    { source: "/api/[...rest]", headers: { "cache-control": "no-store" } },
    { source: "/docs/[...rest]", headers: { "x-hello-routing": "config" } },
  ],
  plugins: [
    // Markdoc: `.mdoc` files compile to Preact modules at build time. Tags render elements or the
    // exports of markdoc/components.tsx; unknown tags or bad attributes fail the build.
    markdoc({
      components: "./markdoc/components.tsx",
      tags: {
        callout: { render: "Callout", attributes: { type: { type: String, matches: ["note", "tip", "warning"] } } },
        counter: { render: "Counter", selfClosing: true, attributes: { start: { type: Number } } },
      },
    }),
    {
      name: "mark-replace",
      transform(code, id) {
        if (!code.includes("__PLUGIN_MARK__")) return null;
        return code.replaceAll("__PLUGIN_MARK__", "transformed-by-plugin");
      },
    },
    {
      // Virtual module: generates and serves `virtual:build-info`, which isn't on disk.
      name: "virtual-build-info",
      resolveId(source) {
        return source === "virtual:build-info" ? source : null;
      },
      load(id) {
        if (id !== "virtual:build-info") return null;
        return `export const builtBy = "nowaki-plugin";\nexport const marker = "VIRTUAL_OK";\n`;
      },
    },
  ],
};
