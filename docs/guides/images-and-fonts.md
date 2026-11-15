# Images and fonts

Nowaki builds responsive images and self-hosted fonts at build time, in Rust. Pages get
`<picture>` elements with an AVIF source and intrinsic sizes, and font files served from the
app with size-matched fallbacks, so neither causes layout shift and neither calls a third-party
host at runtime.

## Images

Import an image with `?image` and render it with `<Image>`:

```tsx
// routes/gallery.tsx
import { Image } from "@nowaki-dev/runtime/image";
import hero from "../hero.jpg?image";
import heroSmall from "../hero.jpg?w=320,480&image";

export default function Gallery() {
  return (
    <main>
      <Image src={hero} alt="A gradient" loading="eager" fetchpriority="high" />
      <Image src={heroSmall} alt="" width={320} />
    </main>
  );
}
```

`<Image>` renders a `<picture>` with an AVIF `<source>` and an `<img>` in the original format,
each with a `srcset`.

- **Widths:** 640, 960, 1280 and 1920 px below the original's width, plus the original (at most
  2560 px). Nothing is upscaled. `?w=400,800&image` (or `?image&w=400,800`) picks the widths.
- **Quality:** `?image&q=70` sets the AVIF quality (1 to 100, default 60). The fallback is the
  original format (JPEG, PNG or WebP). SVG, GIF and other formats pass through unresized.
- **Size:** `width` and `height` come from the file (EXIF orientation applied), so the browser
  reserves the space. Pass `width` to render smaller; `height` follows the aspect ratio.
- **Defaults:** `loading="lazy"`, `decoding="async"`, and `sizes` of
  `(min-width: <width>px) <width>px, 100vw`. For the page's main image use `loading="eager"` and
  `fetchpriority="high"`.
- `alt` is required (it throws without one); use `""` for a decorative image.
- Other `<img>` attributes (`class`, `style`, `id`, event handlers) pass through to the `<img>`.
- `<Image>` works in pages, layouts and islands.
- A plain string `src` renders a bare `<img>`, not optimized: set `width` and `height` yourself.

Variants are cached in `node_modules/.cache/nowaki/images`, so only the first build encodes
them. In `nowaki dev`, variants are encoded on first request.

The scaffold's `nowaki-env.d.ts` types `?image` imports as `ImageSource`. Add it (and its
`tsconfig.json` `include` entry) if the app predates it.

Working examples: `examples/hello/routes/gallery.tsx`, `examples/gallery/routes/posts/`.

### Remote images

A remote URL with `?image` is downloaded at build time and optimized like a local file, when an
`images.remotePatterns` entry in nowaki.config allows it:

```js
// nowaki.config.mjs
import { defineConfig } from "@nowaki-dev/runtime/config";

export default defineConfig({
  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.example.com", pathname: "/photos/**" }],
  },
});
```

```tsx
import photo from "https://images.example.com/photos/a.jpg?image";
```

- `hostname` may start with `*.` (one label) or `**.` (any number); `pathname` is a glob;
  `protocol` defaults to `https`; `port` is optional.
- A `?image` import no pattern allows fails the build.
- Downloads are cached under `node_modules/.cache/nowaki/images/remote`. A cached image never
  touches the network again; `NOWAKI_IMAGES_REFRESH=1` downloads it again.
- Refused: private, loopback and link-local addresses, redirects outside the patterns (at most
  3), bodies over 20 MB, responses slower than 15 s, and anything but PNG, JPEG, WebP or GIF.
- Nothing is fetched at runtime.

Remote images in MDX and in Markdown content entries are optimized the same way when a pattern
allows them, and stay a plain `<img>` with a warning otherwise.

### Images in Markdown and MDX

`![alt](./photo.jpg)` with a local path in a content entry or an MDX file becomes the same
`<picture>`. A missing file fails the build. See [Content](./content.md#markdown).

### Images under a CSP

With `NOWAKI_CSP` on, the policy's `img-src` is `'self' data:`. Optimized images are served
from the app (`/_nowaki/`), so they load; a plain remote `<img src="https://...">` is blocked.
See [Security](./security.md#content-security-policy).

## Fonts

List fonts in nowaki.config. Google fonts are downloaded at build time; local files are copied.

```js
// nowaki.config.mjs
import { defineConfig } from "@nowaki-dev/runtime/config";

export default defineConfig({
  fonts: [
    { family: "Inter", provider: "google", weights: [400, 700], subsets: ["latin"] },
    { family: "Brand", src: "./fonts/brand.ttf", weight: "100 900", variable: "--font-brand" },
  ],
});
```

```css
/* styles/site.css */
body { font-family: var(--font-inter); }
h1 { font-family: var(--font-brand); }
```

Every page gets the fonts' stylesheet and `<link rel="preload">` for the latin, upright faces.

| Key | Google | Local | Default |
| --- | --- | --- | --- |
| `family` | yes | yes | required |
| `provider: "google"` | required | no | |
| `weights`, `styles`, `subsets` | yes | no | `[400]`, `["normal"]`, `["latin"]` |
| `src` | no | a file path, or `[{ path, weight, style }]` | required |
| `weight`, `style` | no | with a single `src` | `400`, `"normal"` |
| `fallback` | yes | yes | `"sans-serif"` (or `"serif"`, `"monospace"`) |
| `variable` | yes | yes | `--font-<family>` |
| `display` | yes | yes | `"swap"` |
| `preload` | yes | yes | `true` |

- **Google fonts** are served from the app, one woff2 per subset with its `unicode-range`, so a
  page loads only the subsets it uses. Downloads are cached, so later builds work offline.
  Families with numbered slices (CJK) keep every slice; only slices that cover basic Latin are
  preloaded.
- **Local fonts**: `src` is relative to the app root. A variable font takes a weight range
  (`weight: "100 900"`). For several files, give an array, one entry per face:
  `src: [{ path: "./fonts/a-400.woff2", weight: 400 }, { path: "./fonts/a-700.woff2", weight: 700 }]`.
- **Fallbacks**: each family gets a local fallback face (Arial, Times New Roman or Courier New,
  by `fallback`) with `size-adjust` and ascent / descent / line-gap overrides computed from the
  font's metrics, so text doesn't move when the font arrives. Metrics can't be read from woff /
  woff2 files; such a family gets no adjusted fallback.
- `variable` names the CSS custom property holding the stack (`--font-inter` for "Inter").
- Keys are validated: an unknown key, or a key of the other kind (`weights` on a local font,
  `weight` on a Google one), fails the build naming the right key.
- In `nowaki dev`, fonts build in the background at startup. Restart `nowaki dev` after changing
  `fonts`.

Working example: `examples/hello/nowaki.config.mjs` (a local font with `variable`).

## Reference

- [Runtime API](../reference/runtime.md) (`@nowaki-dev/runtime/image`: `Image`, `ImageProps`,
  `ImageSource`)
- [Config](../reference/config.md) (`images`, `fonts`)
