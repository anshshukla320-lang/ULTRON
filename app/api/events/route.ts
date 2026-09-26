import { onPageEvent } from "@/lib/agent/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events for the page — e.g. the push-to-talk hotkey. */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      send(": connected\n\n");
      const off = onPageEvent((e) => send(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      // Proxies and browsers drop idle streams; a comment every 25 s keeps it open.
      const ping = setInterval(() => send(": ping\n\n"), 25_000);
      cleanup = () => {
        off();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
