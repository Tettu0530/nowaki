// The gallery. A click on a thumbnail is a client navigation to /photo/[id], which the @modal
// slot intercepts: the URL changes and the photo opens over this page.
import { Image } from "@nowaki-dev/runtime/image";
import { Link, localePath, route } from "@nowaki-dev/runtime/navigation";
import { photos, photoTitle } from "../lib/photos.ts";
import { t } from "../lib/i18n.ts";

export const title = "Gallery";

export default function Gallery() {
  return (
    <main>
      <h1 id="gallery">{t("gallery")}</h1>
      <ul class="grid">
        {photos.map((photo) => (
          <li key={photo.id}>
            <Link id={`photo-${photo.id}`} href={localePath(route("/photo/[id]", { id: photo.id }))}>
              <Image src={photo.image} alt={photoTitle(photo)} width={120} />
              <span>{photoTitle(photo)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
