// The docs collection, listed in `order`.
import { getCollection } from "@nowaki-dev/runtime/content";

export const title = "Docs — Nowaki";

export const loader = async () => {
  const docs = await getCollection("docs", (d) => !d.data.draft);
  return docs.sort((a, b) => a.data.order - b.data.order).map((d) => ({ slug: d.slug, title: d.data.title }));
};

export default function Docs({ data }: { data: { slug: string; title: string }[] }) {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Docs</h1>
      <ul data-testid="docs">
        {data.map((d) => (
          <li>
            <a href={`/docs/${d.slug}`}>{d.title}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
