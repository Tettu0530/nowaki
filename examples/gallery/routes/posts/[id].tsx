// A post: cached (ISR) with two tags, "photos" (every post and the list) and "photo:<id>" (this
// post only). The caption form's action saves the caption and calls revalidateTag("photo:<id>"):
// the cached copies of this post (in both locales) are purged before the redirect goes out, so
// the next GET renders the new caption, on `nowaki start` and on a CDN adapter (Vercel,
// Cloudflare). The other posts and the list stay cached.
import { revalidateTag } from "@nowaki-dev/runtime";
import type { LoaderContext, PageProps } from "@nowaki-dev/runtime";
import { Image } from "@nowaki-dev/runtime/image";
import { href, Link, localePath, transitionName } from "@nowaki-dev/runtime/navigation";
import Likes from "../../islands/Likes.tsx";
import { CAPTION_MAX, caption, setCaption } from "../../lib/posts.ts";
import { findPhoto, photos, photoTitle } from "../../lib/photos.ts";
import { t } from "../../lib/i18n.ts";

export const revalidate = 3600;
export const tags = ({ params }: { params: { id: string } }) => ["photos", `photo:${params.id}`];

// First-load JS for this page (KB, gzip): `nowaki build` fails past it, and the dev toolbar's JS tab
// shows the page against it.
export const budget = { js: 12 };

export const staticPaths = photos.map((p) => ({ id: p.id }));

export function loader(ctx: LoaderContext) {
  const id = String(ctx.params.id);
  if (!findPhoto(id)) ctx.status(404);
  return { caption: caption(id) };
}

// Reached only signed in (routes/posts/_middleware.ts) and from this site: a cross-site POST gets
// 403 before the action runs (the default CSRF check).
export async function action(ctx: LoaderContext) {
  const id = String(ctx.params.id);
  const text = String((await ctx.formData()).get("caption") ?? "").trim();
  if (!findPhoto(id) || !text || text.length > CAPTION_MAX) {
    ctx.status(400);
    return { error: true };
  }
  setCaption(id, text);
  revalidateTag(`photo:${id}`);
  return ctx.redirect(localePath(`/posts/${id}`, ctx.locale), 303);
}

export default function Post({ params, data }: PageProps<typeof loader>) {
  const photo = findPhoto(String(params.id));
  if (!photo) return <main id="post-missing">404</main>;
  return (
    <main id="post-page">
      <h1>{photoTitle(photo)}</h1>
      <Image src={photo.image} alt={photoTitle(photo)} loading="eager" style={transitionName(`photo-${photo.id}`)} />
      <p id="caption">{data.caption}</p>
      <Likes label={t("like")} />
      <form method="post" id="edit" action={href(`/posts/${photo.id}`)}>
        <label>
          {t("caption")} <input name="caption" maxlength={CAPTION_MAX} required />
        </label>{" "}
        <button type="submit">{t("save")}</button>
      </form>
      <p class="hint">{t("signInToEdit")}</p>
      <p>
        <Link id="all-posts" viewTransition href="/posts">
          {t("allPosts")}
        </Link>
      </p>
    </main>
  );
}
