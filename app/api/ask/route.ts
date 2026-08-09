import { requireViewer } from "@/lib/auth";
import { ask } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Fire-and-forget: the answer streams back over `/api/events`, not here. */
export async function POST(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  let question = "";
  try {
    const body = (await request.json()) as { question?: string };
    question = (body.question ?? "").trim();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }
  if (!question) {
    return Response.json({ error: "question is required" }, { status: 400 });
  }

  void ask(question.slice(0, 2000), who.userId);
  return Response.json({ accepted: true }, { status: 202 });
}
