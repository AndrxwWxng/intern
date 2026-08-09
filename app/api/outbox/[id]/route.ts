import { requireViewer } from "@/lib/auth";
import { approveAndSend, rejectAction } from "@/lib/store";
import type { Draft } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Only the fields a person can rewrite before approving. */
function edits(raw: unknown): Partial<Draft> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const out: Partial<Draft> = {};
  const list = (v: unknown) =>
    Array.isArray(v)
      ? v.map(String)
      : typeof v === "string"
        ? v.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

  const to = list(input.to);
  if (to) out.to = to;
  const cc = list(input.cc);
  if (cc) out.cc = cc;
  for (const field of ["subject", "body", "startsAt", "endsAt"] as const) {
    if (typeof input[field] === "string") out[field] = input[field] as string;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Approving sends it, when a connector for that surface is configured. If none
 * is, the draft stays `approved` and waits for an external sender to pick it up
 * over MCP.
 *
 * `edits` is what the person changed before saying yes. It never overwrites the
 * proposal — both halves are kept, because the difference between them is the
 * only thing that teaches the next intern anything.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/outbox/[id]">,
) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  const { id } = await ctx.params;
  let body: { decision?: string; reason?: string; edits?: unknown };
  try {
    body = (await request.json()) as {
      decision?: string;
      reason?: string;
      edits?: unknown;
    };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  if (body.decision === "approve") {
    const { action, dispatched } = await approveAndSend(
      id,
      "cockpit",
      edits(body.edits),
      who.userId,
    );
    if (!action) {
      return Response.json({ error: `no pending action ${id}` }, { status: 400 });
    }
    return Response.json({ action, dispatched });
  }

  if (body.decision === "reject") {
    const action = rejectAction(
      id,
      body.reason ?? "rejected in the cockpit",
      "cockpit",
      who.userId,
    );
    return action
      ? Response.json({ action, dispatched: false })
      : Response.json({ error: `no open action ${id}` }, { status: 400 });
  }

  return Response.json({ error: "decision must be approve or reject" }, { status: 400 });
}
