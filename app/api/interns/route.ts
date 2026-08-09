import { requireViewer } from "@/lib/auth";
import { probe, snapshot, spawn } from "@/lib/store";

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
  try {
    const body = (await request.json()) as { task?: string };
    task = (body.task ?? "").trim();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!task) return Response.json({ error: "task is required" }, { status: 400 });
  if (task.length > 2000) task = task.slice(0, 2000);

  await probe();
  return Response.json({ intern: spawn(task, { ownerId: who.userId }) }, { status: 201 });
}
