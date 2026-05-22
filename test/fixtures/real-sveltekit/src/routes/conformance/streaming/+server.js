// Streaming response: a ReadableStream body that pushes chunks over
// time. The entry must NOT buffer the whole response before flushing.
export async function GET() {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("chunk-a|"));
      await new Promise((r) => setTimeout(r, 10));
      controller.enqueue(enc.encode("chunk-b|"));
      await new Promise((r) => setTimeout(r, 10));
      controller.enqueue(enc.encode("chunk-c"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
