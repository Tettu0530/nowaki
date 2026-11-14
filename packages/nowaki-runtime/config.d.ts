// Types for nowaki.config.mjs (`@nowaki-dev/runtime/config`). `nowaki dev` / `nowaki build`
// validate the config when they read it: an unknown key or an invalid value fails with a message
// naming it.

/**
 * nowaki.config.mjs (or `.js`): the default export. Any other top-level key is an error (with a
 * "did you mean" hint), so a typo such as `basepath` fails instead of doing nothing.
 * @example
 * import { defineConfig } from "@nowaki-dev/runtime/config";
 * export default defineConfig({ site: "https://example.com", basePath: "/app" });
 */
export interface NowakiConfig {
  /**
   * The site's absolute URL (`https://example.com`), for canonical and Open Graph links,
   * sitemap.xml and robots.txt. `NOWAKI_SITE` wins over it at runtime.
   */
  site?: string;
  /** Self-hosted fonts, downloaded or copied at build time (see {@link FontConfig}). */
  fonts?: FontConfig[];
  /** Serves the app under a path prefix (`"/app"`). `<Link>`, `href()` and `ctx.redirect` add it. */
  basePath?: string;
  /** `"never"` / `"always"` redirect to the form without / with a trailing slash; `"ignore"` (the default) serves both. */
  trailingSlash?: "never" | "always" | "ignore";
  /** Redirects, checked before routing. A function (possibly async) is called once at startup. */
  redirects?: RuleList<RedirectRule>;
  /** Internal rewrites: the request is routed by `destination`, the browser keeps its URL. */
  rewrites?: RuleList<RewriteRule>;
  /** Response headers by path. They replace the default security headers of the same name. */
  headers?: RuleList<HeaderRule>;
  /** Locales: the default one at `/`, the others under `/<locale>/`. */
  i18n?: I18nConfig;
  /** `<Image>` options. */
  images?: ImagesConfig;
  /**
   * Build-time plugins (`@nowaki-dev/markdoc`, or your own {@link NowakiPlugin}). A falsy entry is
   * skipped, so `cond && plugin()` works.
   */
  plugins?: (NowakiPlugin | false | null | undefined)[];
}

/** An array of rules, or a function (possibly async) returning one, called once. */
export type RuleList<R> = R[] | (() => R[] | Promise<R[]>);

/**
 * `source` is a path pattern (`/blog/[slug]`, `/docs/[...rest]`); a `[param]` captured there can be
 * used in `destination`. With `i18n`, a rule matches the path without its locale prefix unless
 * `locale: false`.
 */
export interface RedirectRule {
  source: string;
  /** A path, or an absolute http(s) URL. */
  destination: string;
  /** `true`: 308, else 307 (unless `statusCode`). */
  permanent?: boolean;
  statusCode?: 301 | 302 | 303 | 307 | 308;
  /** `false`: match `source` against the path with its locale prefix. */
  locale?: boolean;
}

export interface RewriteRule {
  source: string;
  /** A path in this app (rewrites are internal; use a redirect for another site). */
  destination: string;
  locale?: boolean;
}

export interface HeaderRule {
  source: string;
  /** Header names to values, or `{ key, value }` pairs. */
  headers: Record<string, string | number> | { key: string; value: string }[];
  locale?: boolean;
}

export interface I18nConfig {
  /** Locale tags (`"en"`, `"pt-BR"`). */
  locales: string[];
  /** One of `locales`, served without a prefix unless `prefixDefaultLocale`. */
  defaultLocale: string;
  /** Serve the default locale under its prefix too (`/en/...`). Default false. */
  prefixDefaultLocale?: boolean;
  /** Send `/` to the visitor's locale (the `nowaki_locale` cookie, then `Accept-Language`). Default false. */
  detect?: boolean;
}

export interface ImagesConfig {
  /** The remote hosts `<Image src="https://...">` may fetch from at build time. */
  remotePatterns?: {
    protocol?: "https" | "http";
    /** A host name; `*.` matches one label, `**.` any number, only as a prefix. */
    hostname: string;
    port?: string | number;
    /** A path glob starting with `/` (`/photos/**`). */
    pathname?: string;
  }[];
}

/**
 * A `fonts` entry: a Google font ({@link GoogleFont}) or a local file ({@link LocalFont}). Keys of
 * the other kind are an error (`weights` on a local font, `weight` on a Google one).
 */
export type FontConfig = GoogleFont | LocalFont;

interface FontCommon {
  /** The CSS family name. */
  family: string;
  /** The local fallback whose metrics are adjusted to match. Default `"sans-serif"`. */
  fallback?: "sans-serif" | "serif" | "monospace";
  /** The custom property holding the font stack. Default `--font-<family>`. */
  variable?: string;
  /** `font-display`. Default `"swap"`. */
  display?: "auto" | "block" | "swap" | "fallback" | "optional";
  /** Preload the latin, upright faces. Default true. */
  preload?: boolean;
}

/** Downloaded from Google Fonts at build time and served from the app (pages never call Google). */
export interface GoogleFont extends FontCommon {
  provider: "google";
  /** Default `[400]`. */
  weights?: (number | string)[];
  /** Default `["normal"]`. */
  styles?: ("normal" | "italic")[];
  /** Default `["latin"]`. Unnamed slices (CJK families) are always kept. */
  subsets?: string[];
  src?: never;
  weight?: never;
  style?: never;
}

/** A font file in the app, copied into the build. Paths are relative to the app root. */
export type LocalFont = FontCommon & {
  provider?: never;
  weights?: never;
  styles?: never;
  subsets?: never;
} & (
    | {
        /** One file (`"./fonts/brand.ttf"`). */
        src: string;
        /** A weight, or a range for a variable font (`"100 900"`). Default 400. */
        weight?: number | string;
        /** Default `"normal"`. */
        style?: "normal" | "italic";
      }
    | {
        /** One entry per face. */
        src: { path: string; weight?: number | string; style?: "normal" | "italic" }[];
        weight?: never;
        style?: never;
      }
  );

/** A hook's result: the new code (a string or `{ code }`), or null / undefined for "not mine". */
export type PluginCode = string | { code: string } | null | undefined;

/**
 * A build-time plugin in `plugins`. The hooks follow Rollup's names and arguments, run in the
 * plugin host (a Node process `nowaki dev` / `nowaki build` start), and may be async.
 */
export interface NowakiPlugin {
  /** Shown in errors. */
  name: string;
  /** Rewrites a module's source (`id` is its absolute path). Plugins run in order, each on the previous output. */
  transform?(code: string, id: string): PluginCode | Promise<PluginCode>;
  /** Resolves an import specifier to an id (a virtual module, say). The first plugin to return one wins. */
  resolveId?(
    source: string,
    importer: string,
  ): string | { id: string } | null | undefined | Promise<string | { id: string } | null | undefined>;
  /** The source of an id (from `resolveId`). The first plugin to return one wins. */
  load?(id: string): PluginCode | Promise<PluginCode>;
}

/** Returns `config` unchanged; it only types it as {@link NowakiConfig}. */
export function defineConfig(config: NowakiConfig): NowakiConfig;
