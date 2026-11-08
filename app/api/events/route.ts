import { auth } from "@clerk/nextjs";

import { subscribeToBoardEvents } from "@/lib/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream of board changes for the caller's active org.
 * The browser reconnects automatically (EventSource) if the stream drops.
 */
export async function GET(request: Request) {
  const { userId, orgId } = auth();

  if (!userId || !orgId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup?.();
        }
      };

      const unsubscribe = await subscribeToBoardEvents((event) => {
        if (event.orgId !== orgId) return;
        send(`event: board\ndata: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };

      request.signal.addEventListener("abort", () => cleanup?.());

      // Tell the browser how fast to reconnect, and confirm the stream is open.
      send("retry: 2000\n: connected\n\n");
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
