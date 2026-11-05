// A dynamic file route: /og/intro.png, /og/routing.png. Returning bytes sends them as image/png
// (from the extension). `staticPaths` lists the files the static output gets; a real app would
// draw a card per entry here (with resvg, satori, …).
import { getCollection } from "@nowaki-dev/runtime/content";

// 1×1 PNG
const PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

export async function staticPaths() {
  return (await getCollection("docs")).map((d) => ({ card: d.slug }));
}

export async function GET({ params }: { params: { card: string } }) {
  const ids = (await getCollection("docs")).map((d) => d.slug);
  if (!ids.includes(params.card)) return new Response("not found", { status: 404 });
  return PIXEL;
}
