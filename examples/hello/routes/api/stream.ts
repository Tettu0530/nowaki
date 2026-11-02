// Streaming response demo. A web Response + ReadableStream can be returned as-is.
export function GET() {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode("chunk1\n"));
      controller.enqueue(enc.encode("chunk2\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
