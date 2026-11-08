// One entry of the docs collection: its HTML was rendered at build time, with heading anchors.
import { getCollection, getEntry } from "@nowaki-dev/runtime/content";
import type { LoaderContext } from "@nowaki-dev/runtime";
import { h } from "preact";

export const staticPaths = async () => (await getCollection("docs")).map((d) => ({ slug: d.slug }));

export const loader = async (ctx: LoaderContext) => {
  const doc = await getEntry("docs", String(ctx.params.slug));
  if (!doc) return ctx.redirect("/docs");
  // MDX and Markdoc entries render as a component (with their islands); Markdown entries as HTML.
  const mod = doc.render ? await doc.render() : null;
  return { title: doc.data.title, html: doc.html ?? "", headings: mod?.headings ?? doc.headings ?? [], Content: mod?.Content };
};

// Typed metadata: description, canonical, Open Graph (its image is the og/[card].png file route),
// Twitter, and JSON-LD. Relative URLs resolve against `site` in nowaki.config.
export const meta = ({ data, params }: { data: { title: string }; params: { slug: string } }) => ({
  title: `${data.title} — Nowaki docs`,
  description: `${data.title}, from the Nowaki demo docs.`,
  canonical: true as const,
  openGraph: { type: "article", image: { url: `/og/${params.slug}.png`, width: 1, height: 1, alt: data.title } },
  jsonLd: { "@context": "https://schema.org", "@type": "TechArticle", headline: data.title },
});

type Props = {
  data: {
    title: string;
    html: string;
    headings: { depth: number; text: string; id: string }[];
    Content?: (props?: Record<string, unknown>) => unknown;
  };
};

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
      {data.Content ? (
        <article data-testid="doc">{h(data.Content as never, null)}</article>
      ) : (
        <article data-testid="doc" dangerouslySetInnerHTML={{ __html: data.html }} />
      )}
    </main>
  );
}
