import { requireViewer } from "@/lib/auth";
import { isRoleId } from "@/lib/roster";
import { probe, snapshot, spawn } from "@/lib/store";
import type { RoleId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  return Response.json({ interns: snapshot(who.userId).interns });
}

export async function POST(request: Request) {
  // Auth first: an intern with no owner would be one nobody can see and nobody
  // can stop, so there is no anonymous path to dispatching one.
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  let task = "";
  let role: RoleId | undefined;
  try {
    const body = (await request.json()) as { task?: string; role?: string };
    task = (body.task ?? "").trim();
    // An unknown role is not worth failing over — one gets picked from the
    // brief, which is what happens when none is given anyway.
    if (isRoleId(body.role)) role = body.role;
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!task) return Response.json({ error: "task is required" }, { status: 400 });
  if (task.length > 2000) task = task.slice(0, 2000);

  await probe();
  return Response.json(
    { intern: spawn(task, { ownerId: who.userId, role }) },
    { status: 201 },
  );
}
