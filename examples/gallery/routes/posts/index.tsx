// The post list: cached (ISR) and tagged "photos". A click on a card is a client navigation to
// the post that runs as a View Transition (<Link viewTransition>): the thumbnail carries the same
// transitionName() as the post's photo, so one morphs into the other. Browsers without the API,
// and visitors who prefer reduced motion, get the same navigation without the animation.
import { Image } from "@nowaki-dev/runtime/image";
import { Link, route, transitionName } from "@nowaki-dev/runtime/navigation";
import { photos, photoTitle } from "../../lib/photos.ts";
import { t } from "../../lib/i18n.ts";

export const title = "Posts";

// Cached for an hour; revalidateTag("photos") would drop it (and every post) at once.
export const revalidate = 3600;
export const tags = ["photos"];

export default function Posts() {
  return (
    <main>
      <h1 id="posts">{t("posts")}</h1>
      <ul class="grid">
        {photos.map((photo) => (
          <li key={photo.id}>
            <Link id={`post-${photo.id}`} viewTransition href={route("/posts/[id]", { id: photo.id })}>
              <Image src={photo.image} alt={photoTitle(photo)} width={120} style={transitionName(`photo-${photo.id}`)} />
              <span>{photoTitle(photo)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
