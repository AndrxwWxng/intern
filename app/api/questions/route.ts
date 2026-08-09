import { requireViewer } from "@/lib/auth";
import { listQuestions } from "@/lib/store";
import type { Question } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  const status = new URL(request.url).searchParams.get("status");
  return Response.json({
    questions: listQuestions(
      (status as Question["status"]) || undefined,
      who.userId,
    ),
  });
}
