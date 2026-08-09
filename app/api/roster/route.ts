import { ROLES, isRoleId } from "@/lib/roster";
import { graduateRole, probe, trustRecords } from "@/lib/store";
import { THRESHOLDS } from "@/lib/trust";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Trust is replayed from the log at boot, so it is not readable until that
  // has happened. probe() is where the replay is awaited.
  await probe();
  return Response.json({
    roles: ROLES.map(({ id, name, blurb }) => ({ id, name, blurb })),
    trust: trustRecords(),
    thresholds: THRESHOLDS,
  });
}

/**
 * Confirm or decline a proposed graduation. There is no path to this from the
 * system side — an intern moving off supervision is always a person's call.
 */
export async function POST(request: Request) {
  let body: { role?: string; confirmed?: boolean };
  try {
    body = (await request.json()) as { role?: string; confirmed?: boolean };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!isRoleId(body.role)) {
    return Response.json(
      { error: `unknown role: ${body.role ?? "(none)"}` },
      { status: 400 },
    );
  }
  return Response.json({ trust: graduateRole(body.role, body.confirmed === true) });
}
