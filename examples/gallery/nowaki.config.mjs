// The v0.18 "Sirocco" example: a photo gallery served under /gallery in English and Japanese.
export default {
  // Absolute canonical / hreflang links and the sitemap.
  site: "https://gallery.nowaki.dev",
  // Everything (pages, /_nowaki/ assets, server endpoints, the session cookie) lives under
  // /gallery. <Link> and ctx.redirect add the base; config rules below are relative to it.
  basePath: "/gallery",
  // English at /gallery/..., Japanese at /gallery/ja/... (/gallery/en/x redirects to /gallery/x).
  // `detect` sends a first visit to /gallery to /gallery/ja when the browser prefers Japanese; the
  // language switcher's choice (the nowaki_locale cookie) wins over Accept-Language.
  i18n: { locales: ["en", "ja"], defaultLocale: "en", detect: true },
  // Rules see the path after the base and before the locale split: `/photos/1` matches here,
  // `/ja/photos/1` does not.
  redirects: [{ source: "/photos/[id]", destination: "/photo/[id]", permanent: true }],
  headers: [{ source: "/login", headers: { "x-robots-tag": "noindex" } }],
};
