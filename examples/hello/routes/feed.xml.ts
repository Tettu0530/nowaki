// A file route: the last segment has an extension, so this returns the file itself (typed by the
// extension, application/xml) instead of rendering a page. `nowaki build --adapter static` writes
// it to feed.xml.
import { getCollection } from "@nowaki-dev/runtime/content";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export async function GET({ url }: { url: URL }) {
  const docs = await getCollection("docs");
  const items = docs
    .map((d) => `  <item><title>${esc(String(d.data.title))}</title><link>${url.origin}/docs/${d.slug}</link></item>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Nowaki demo docs</title>
${items}
</channel></rss>
`;
}
