// Streaming response demo. A web Response + ReadableStream can be returned as-is.
// `?delay=<ms>` waits between the two chunks, to show they reach the client one at a time.
export function GET({ url }: { url: URL }) {
  const delay = Math.min(Number(url.searchParams.get("delay")) || 0, 5000);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode("chunk1\n"));
      if (delay) await new Promise((r) => setTimeout(r, delay));
      controller.enqueue(enc.encode("chunk2\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
