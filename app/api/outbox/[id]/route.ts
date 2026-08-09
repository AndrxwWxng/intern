import { approveAction, rejectAction } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Approving here marks the draft ready — it does not send. Whoever holds the
 * credentials (VoiceOS) picks it up and reports back via MCP.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/outbox/[id]">,
) {
  const { id } = await ctx.params;
  let body: { decision?: string; reason?: string };
  try {
    body = (await request.json()) as { decision?: string; reason?: string };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const action =
    body.decision === "approve"
      ? approveAction(id, "cockpit")
      : body.decision === "reject"
        ? rejectAction(id, body.reason ?? "rejected in the cockpit", "cockpit")
        : null;

  if (!action) {
    return Response.json(
      { error: `cannot ${body.decision ?? "decide"} ${id}` },
      { status: 400 },
    );
  }
  return Response.json({ action });
}
