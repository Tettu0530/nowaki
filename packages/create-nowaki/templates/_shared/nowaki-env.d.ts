// Nowaki ambient types, so editors understand CSS / asset / virtual-module imports.
// No need to edit (it only teaches the type checker the framework's import conventions).
// Keep this file free of top-level import / export. Either one makes it a module, and then the
// `declare module "*..."` wildcards below stop being ambient declarations. The preact JSX
// additions (client:* directives) need a module, so they are in nowaki-jsx.d.ts.

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

// import.meta.env (PUBLIC_*, MODE and BASE_URL are inlined at build time). These are global
// because this file is not a module. `nowaki typegen` adds the types of env.ts's public values
// in .nowaki/types.d.ts.
interface ImportMetaEnv {
  readonly MODE: string;
  /** nowaki.config `basePath` with a trailing slash ("/app/"), or "/". */
  readonly BASE_URL: string;
  readonly [key: `PUBLIC_${string}`]: string | undefined;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
