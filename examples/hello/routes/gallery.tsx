// <Image>: hero.jpg (1200×750) imported with `?image` becomes AVIF + JPEG at 640 / 960 / 1200 px,
// with its own width / height (no layout shift). The second one picks its own widths.
import { Image } from "@nowaki-dev/runtime/image";
import hero from "../hero.jpg?image";
import heroSmall from "../hero.jpg?w=320,480&image";

export const title = "Gallery — Nowaki";

export default function Gallery() {
  return (
    <main>
      <h1>Gallery</h1>
      <Image src={hero} alt="A gradient" loading="eager" fetchpriority="high" />
      <Image src={heroSmall} alt="" width={320} data-testid="small" />
    </main>
  );
}
