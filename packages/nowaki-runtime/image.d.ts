import type { JSX } from "preact";

/** What `import x from "./x.jpg?image"` gives: the file's size and its generated variants. */
export interface ImageSource {
  /** The `<img src>`: the largest fallback variant. */
  src: string;
  /** Intrinsic size from the file (0 for formats that aren't decoded, like SVG). */
  width: number;
  height: number;
  /** AVIF first, the original format last (the `<img>`'s own srcset). */
  sources: { type: string; srcset: string }[];
}

export type ImageProps = Omit<JSX.HTMLAttributes<HTMLImageElement>, "src" | "srcset" | "width" | "height"> & {
  /** A `?image` import, or a plain URL (then set width / height yourself). */
  src: ImageSource | string;
  /** Required; use "" for a decorative image. */
  alt: string;
  /** Defaults to `(min-width: <width>px) <width>px, 100vw`. */
  sizes?: string;
  /** Rendered width; height follows the aspect ratio unless given. Defaults to the file's. */
  width?: number;
  height?: number;
  /** Defaults to "lazy"; use "eager" (and fetchpriority="high") for the page's main image. */
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
};

/** A responsive `<picture>` (AVIF, then the original format) with no layout shift. */
export function Image(props: ImageProps): JSX.Element;
