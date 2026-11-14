// Types for `@nowaki-dev/runtime/image`: `<Image>` and `?image` imports.

import type { JSX } from "preact";

/** What `import x from "./x.jpg?image"` gives: the file's size and its generated variants. */
export interface ImageSource {
  /** The `<img src>`: the largest fallback variant. */
  src: string;
  /** Intrinsic size from the file (0 for formats that aren't decoded, like SVG). */
  width: number;
  /** Intrinsic height (0 when `width` is). */
  height: number;
  /** AVIF first, the original format last (the `<img>`'s own srcset). */
  sources: { type: string; srcset: string }[];
}

/**
 * Props of {@link Image}. Every other `<img>` attribute (`class`, `id`, `style`, `fetchpriority`,
 * event handlers, ...) is passed through to the rendered `<img>`. `JSX.IntrinsicElements["img"]`
 * is the `<img>` props type in both preact 10 and 11 (preact 11 has no `JSX.HTMLAttributes`).
 */
export type ImageProps = Omit<
  JSX.IntrinsicElements["img"],
  "src" | "srcset" | "alt" | "sizes" | "width" | "height" | "loading" | "decoding"
> & {
  /**
   * A `?image` import (local, or a remote URL that `images.remotePatterns` allows, fetched at
   * build time), or a plain URL string: rendered as a bare `<img>`, not optimized (set width /
   * height yourself).
   */
  src: ImageSource | string;
  /** Required; use "" for a decorative image. */
  alt: string;
  /** Defaults to `(min-width: <width>px) <width>px, 100vw`. */
  sizes?: string;
  /** Rendered width; height follows the aspect ratio unless given. Defaults to the file's. */
  width?: number;
  /** Rendered height. Defaults to `width` times the file's aspect ratio. */
  height?: number;
  /** Defaults to "lazy"; use "eager" (and fetchpriority="high") for the page's main image. */
  loading?: "lazy" | "eager";
  /** Defaults to "async". */
  decoding?: "async" | "sync" | "auto";
};

/**
 * A responsive `<picture>` (AVIF, then the original format) with no layout shift, for a `?image`
 * import. Works in pages, layouts and islands. Throws without `alt`.
 * @example
 * import hero from "./hero.jpg?image";
 * <Image src={hero} alt="" loading="eager" />
 */
export function Image(props: ImageProps): JSX.Element;
