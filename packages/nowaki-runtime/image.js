// <Image>: a responsive <picture> for an image imported with `?image`
// (`import hero from "./hero.jpg?image"`), which nowaki turns into AVIF + the original format at
// a few widths, with the file's own width / height. Works in pages, layouts, and islands alike.
import { h } from "preact";

/// `src`: the `?image` import (a remote one too, `https://…?image`, when images.remotePatterns
/// allows it), or a plain URL string, rendered as a bare <img> (then pass `width` / `height`).
/// `sizes` defaults to "the rendered width, or the viewport when narrower".
export function Image({
  src,
  alt,
  sizes,
  width,
  height,
  loading = "lazy",
  decoding = "async",
  ...rest
}) {
  if (alt === undefined) throw new Error("<Image> needs `alt` (an empty string for decorative images)");
  if (typeof src === "string" || !src || !Array.isArray(src.sources)) {
    return h("img", { src, alt, width, height, loading, decoding, ...rest });
  }
  const own = src.width > 0 && src.height > 0;
  const w = width ?? (own ? src.width : undefined);
  const hgt = height ?? (own && w ? Math.round((w * src.height) / src.width) : undefined);
  const sz = sizes ?? (w ? `(min-width: ${w}px) ${w}px, 100vw` : undefined);
  const sources = src.sources.filter((s) => s.srcset);
  const fallback = sources[sources.length - 1];
  const img = h("img", {
    src: src.src,
    srcset: fallback?.srcset,
    sizes: fallback ? sz : undefined,
    width: w,
    height: hgt,
    alt,
    loading,
    decoding,
    ...rest,
  });
  if (sources.length < 2) return img;
  return h(
    "picture",
    null,
    ...sources.slice(0, -1).map((s) => h("source", { type: s.type, srcset: s.srcset, sizes: sz })),
    img,
  );
}
