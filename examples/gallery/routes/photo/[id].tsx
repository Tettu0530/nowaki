// The photo as a full page: a reload, a direct visit, or a shared link.
import type { LoaderContext } from "@nowaki-dev/runtime";
import { Image } from "@nowaki-dev/runtime/image";
import { Link } from "@nowaki-dev/runtime/navigation";
import { findPhoto, photos, photoTitle } from "../../lib/photos.ts";
import { t } from "../../lib/i18n.ts";

// Static output writes one page per photo and locale.
export const staticPaths = photos.map((p) => ({ id: p.id }));

export function loader(ctx: LoaderContext) {
  if (!findPhoto(String(ctx.params.id))) ctx.status(404);
  return {};
}

export default function PhotoPage({ params }: { params: { id: string } }) {
  const photo = findPhoto(params.id);
  if (!photo) return <main id="photo-missing">404</main>;
  return (
    <main id="photo-page">
      <h1>{photoTitle(photo)}</h1>
      <Image src={photo.image} alt={photoTitle(photo)} loading="eager" />
      <p>
        <Link href="/">{t("allPhotos")}</Link>
      </p>
    </main>
  );
}
