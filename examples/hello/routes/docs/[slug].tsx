// One entry of the docs collection: its HTML was rendered at build time, with heading anchors.
import { getCollection, getEntry } from "@nowaki-dev/runtime/content";
import type { LoaderContext } from "@nowaki-dev/runtime";

export const staticPaths = async () => (await getCollection("docs")).map((d) => ({ slug: d.slug }));

export const loader = async (ctx: LoaderContext) => {
  const doc = await getEntry("docs", String(ctx.params.slug));
  if (!doc) return ctx.redirect("/docs");
  return { title: doc.data.title, html: doc.html ?? "", headings: doc.headings ?? [] };
};

export const meta = ({ data }: { data: { title: string } }) => ({ title: `${data.title} — Nowaki docs` });

type Props = { data: { title: string; html: string; headings: { depth: number; text: string; id: string }[] } };

export default function Doc({ data }: Props) {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <nav data-testid="toc">
        {data.headings
          .filter((h) => h.depth === 2)
          .map((h) => (
            <a href={`#${h.id}`} style="margin-right:1rem">
              {h.text}
            </a>
          ))}
      </nav>
      <article data-testid="doc" dangerouslySetInnerHTML={{ __html: data.html }} />
    </main>
  );
}
