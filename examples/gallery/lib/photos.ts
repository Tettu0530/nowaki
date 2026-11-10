// The photos: local files through the image pipeline (`?image`: AVIF + PNG variants, with their
// width / height), and a title per locale.
import { getLocale } from "@nowaki-dev/runtime/navigation";
import dune from "../photos/dune.png?image";
import sea from "../photos/sea.png?image";
import dusk from "../photos/dusk.png?image";

export const photos = [
  // Dune, sea, dusk.
  { id: "1", image: dune, title: { en: "Dune", ja: "\u7802\u4E18" } },
  { id: "2", image: sea, title: { en: "Sea", ja: "\u6D77" } },
  { id: "3", image: dusk, title: { en: "Dusk", ja: "\u5915\u66AE\u308C" } },
];

export type Photo = (typeof photos)[number];

export function findPhoto(id: string): Photo | undefined {
  return photos.find((p) => p.id === id);
}

export function photoTitle(photo: Photo): string {
  return getLocale() === "ja" ? photo.title.ja : photo.title.en;
}
