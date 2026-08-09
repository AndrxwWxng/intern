import { graduateKind, probe, trustRecords } from "@/lib/store";
import { THRESHOLDS } from "@/lib/trust";
import { ACTION_KINDS, type ActionKind } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Trust is replayed from the log at boot, so it is not readable until that
  // has happened. probe() is where the replay is awaited.
  await probe();
  return Response.json({
    trust: trustRecords(),
    thresholds: THRESHOLDS,
  });
}

/**
 * Confirm or decline a proposed graduation. There is no path to this from the
 * system side — work moving off supervision is always a person's call.
 */
export async function POST(request: Request) {
  let body: { kind?: string; confirmed?: boolean };
  try {
    body = (await request.json()) as { kind?: string; confirmed?: boolean };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!ACTION_KINDS.includes(body.kind as ActionKind)) {
    return Response.json(
      { error: `unknown kind: ${body.kind ?? "(none)"} — expected one of ${ACTION_KINDS.join(", ")}` },
      { status: 400 },
    );
  }
  return Response.json({
    trust: graduateKind(body.kind as ActionKind, body.confirmed === true),
  });
}
