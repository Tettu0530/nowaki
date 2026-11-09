// Intercepting route: `(.)photo/[id]` takes over /photo/[id] (same level as the slot's layout)
// on a client navigation from a page under routes/. The router fetches just this file and shows
// it in <nowaki-slot name="modal">; a reload of the same URL renders routes/photo/[id].tsx.
import { Image } from "@nowaki-dev/runtime/image";
import CloseButton from "../../../islands/CloseButton.tsx";
import { findPhoto, photoTitle } from "../../../lib/photos.ts";
import { t } from "../../../lib/i18n.ts";
import "./modal.css";

export default function PhotoModal({ params }: { params: { id: string } }) {
  const photo = findPhoto(params.id);
  if (!photo) return null;
  return (
    <dialog open id="photo-modal" class="modal" aria-label={photoTitle(photo)}>
      <h2>{photoTitle(photo)}</h2>
      <Image src={photo.image} alt={photoTitle(photo)} loading="eager" />
      <CloseButton label={t("close")} />
    </dialog>
  );
}
