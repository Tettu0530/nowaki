// Nowaki ambient types, so editors understand CSS / asset / virtual-module imports.
// No need to edit (it only teaches the type checker the framework's import conventions).

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
declare module "*.css" {
  const css: string;
  export default css;
}

// `?image` gives a responsive image set for <Image> (@nowaki-dev/runtime/image).
declare module "*?image" {
  const image: import("@nowaki-dev/runtime/image").ImageSource;
  export default image;
}
declare module "*&image" {
  const image: import("@nowaki-dev/runtime/image").ImageSource;
  export default image;
}

// An asset import becomes its served URL (a string).
declare module "*.svg" { const url: string; export default url; }
declare module "*.png" { const url: string; export default url; }
declare module "*.jpg" { const url: string; export default url; }
declare module "*.jpeg" { const url: string; export default url; }
declare module "*.gif" { const url: string; export default url; }
declare module "*.webp" { const url: string; export default url; }
declare module "*.avif" { const url: string; export default url; }
declare module "*.ico" { const url: string; export default url; }
declare module "*.woff" { const url: string; export default url; }
declare module "*.woff2" { const url: string; export default url; }
declare module "*.ttf" { const url: string; export default url; }
declare module "*.otf" { const url: string; export default url; }
declare module "*.mp4" { const url: string; export default url; }
declare module "*.webm" { const url: string; export default url; }
declare module "*.mp3" { const url: string; export default url; }
declare module "*.wav" { const url: string; export default url; }
declare module "*.pdf" { const url: string; export default url; }

// MDX: the default export is the content as a component; `headings` lists its headings.
declare module "*.mdx" {
  export const headings: { depth: number; text: string; id: string }[];
  const MDXContent: (props?: Record<string, unknown>) => import("preact").JSX.Element;
  export default MDXContent;
}

// Markdoc (@nowaki-dev/markdoc): the default export renders the file; `frontmatter` is its
// frontmatter and `headings` lists its headings.
declare module "*.mdoc" {
  export const frontmatter: Record<string, any>;
  export const headings: { depth: number; text: string; id: string }[];
  const MarkdocContent: () => import("preact").JSX.Element;
  export default MarkdocContent;
}

// Plugin virtual modules (resolveId/load in nowaki.config). Any export is allowed.
declare module "virtual:*";

// Extends preact's JSX.IntrinsicAttributes so client:* directives can go on any component.
// This import makes the file a module, so the global types below are exposed via declare global.
import "preact";
declare module "preact" {
  namespace JSX {
    interface IntrinsicAttributes {
      /** Hydrate on page load (default). */
      "client:load"?: boolean;
      /** Hydrate when idle, via requestIdleCallback. */
      "client:idle"?: boolean;
      /** Hydrate once visible, via IntersectionObserver. */
      "client:visible"?: boolean;
      /** Hydrate when the media query matches. e.g. client:media="(min-width: 768px)" */
      "client:media"?: string;
      /** Skip SSR and render on the client only (for islands using browser-only APIs). */
      "client:only"?: boolean;
    }
  }
}

declare global {
  // import.meta.env (PUBLIC_* and MODE are inlined at build time).
  interface ImportMetaEnv {
    readonly MODE: string;
    readonly [key: `PUBLIC_${string}`]: string | undefined;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
