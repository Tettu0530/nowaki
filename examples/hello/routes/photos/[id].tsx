export const title = "Photo — Nowaki";
export const staticPaths = [{ id: "1" }];

export default function Photo({ params }: { params: { id: string } }) {
  return (
    <main>
      <h1 id="photo-page">photo {params.id}</h1>
      <a href="/photos">all photos</a>
    </main>
  );
}
