import { requireViewer } from "@/lib/auth";
import { probe, snapshot, subscribe } from "@/lib/store";
import type { CockpitEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Single multiplexed stream: snapshot, then every cockpit event this viewer is
 * entitled to.
 *
 * Not `EventSource` on the client side — it cannot set an Authorization header,
 * and the alternative is a token in the query string, which ends up in every
 * access log between here and the browser. The cockpit reads this with `fetch`
 * instead; the wire format is still SSE.
 */
export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

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

      const snap = snapshot(who.userId);
      send({
        type: "snapshot",
        interns: snap.interns,
        log: snap.log,
        system: snap.system,
        outbox: snap.outbox,
        questions: snap.questions,
        trust: snap.trust,
        brain: snap.brain,
      });
      send({ type: "graph", graph: snap.graph });

      const unsubscribe = subscribe(send, who.userId);
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
