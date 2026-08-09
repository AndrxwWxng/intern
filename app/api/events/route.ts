import { probe, snapshot, subscribe } from "@/lib/store";
import type { CockpitEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Single multiplexed SSE stream: snapshot, then every cockpit event. */
export async function GET(request: Request) {
  await probe();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (e: CockpitEvent | { type: "ping" }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const snap = snapshot();
      send({
        type: "snapshot",
        interns: snap.interns,
        log: snap.log,
        system: snap.system,
        outbox: snap.outbox,
      });
      send({ type: "graph", graph: snap.graph });

      const unsubscribe = subscribe(send);
      // Keepalive — proxies drop idle streams.
      const ping = setInterval(() => send({ type: "ping" }), 20_000);
      // Re-probe scout periodically so LIVE/SIM flips on its own.
      const poll = setInterval(() => void probe(true), 20_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearInterval(poll);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener("abort", close, { once: true });
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
