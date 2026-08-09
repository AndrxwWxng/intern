import { listQuestions } from "@/lib/store";
import type { Question } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status");
  return Response.json({
    questions: listQuestions((status as Question["status"]) || undefined),
  });
}
