// Dynamic route [slug] + nested layouts (blog/_layout -> root/_layout).
type Ctx = { params: { slug: string } };

export const title = "Blog — Nowaki";

// `nowaki prerender` / the static adapter render one page per entry.
export const staticPaths = [{ slug: "hello" }, { slug: "nowaki" }];

export const loader = (ctx: Ctx) => ({ slug: ctx.params.slug });

export default function Post({ data }: { data: { slug: string } }) {
  return (
    <article>
      <h1>Post: {data.slug}</h1>
      <p>Demo of the dynamic segment <code>[slug]</code> and nested layouts.</p>
    </article>
  );
}
