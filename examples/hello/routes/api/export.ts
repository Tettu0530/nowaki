// A download at a URL without a file extension: the client router leaves it to the browser.
// ?ms= delays it (up to 2s), long enough for the router to show the loading boundary first.
export default async function handler({ url }: { url: URL }) {
  const ms = Math.min(Number(url.searchParams.get("ms")) || 0, 2000);
  await new Promise((r) => setTimeout(r, ms));
  return {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="export.csv"' },
    body: "id,name\n1,nowaki\n",
  };
}
