// revalidatePath on long paths. A valid path can be 2048 characters; one of non-ASCII characters
// percent-encodes to more than `nowaki start`'s 8 KB purge header, so the purge goes through the
// sidecar's stdout channel instead (scripts/ci/e2e-prod.sh). The form's `slug` field names
// another page to purge: a 2000-character URL is over Node's 16 KB request header limit, so such
// a page can't be requested, but its path can still be revalidated.
import { revalidatePath } from "@nowaki-dev/runtime";
import type { LoaderContext, PageProps } from "@nowaki-dev/runtime";

// No staticPaths: every page renders on demand (and isn't prerendered or warmed up).
export const revalidate = 300;

let renders = 0;

export const loader = (ctx: LoaderContext) => {
  renders += 1;
  return { renders, length: ctx.params.slug.length };
};

export async function action(ctx: LoaderContext) {
  const form = await ctx.formData();
  const slug = String(form.get("slug") || ctx.params.slug);
  revalidatePath(`/isr-long/${slug}`);
  return ctx.redirect(ctx.url.pathname, 303);
}

export default function IsrLong({ data }: PageProps<typeof loader>) {
  return (
    <main>
      <p>
        slug of {data.length} characters, render #<strong data-testid="isr-long-renders">{data.renders}</strong>
      </p>
      <form method="post">
        <button>revalidatePath</button>
      </form>
    </main>
  );
}
