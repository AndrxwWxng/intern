import { answerQuestion, dismissQuestion } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Answering files the answer as a fact and then dispatches a fresh intern to
 * pick the parked work back up — in that order, so the answer is in the brain
 * for every future task and not just this one.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/questions/[id]">,
) {
  const { id } = await ctx.params;
  let body: { answer?: string; dismiss?: boolean };
  try {
    body = (await request.json()) as { answer?: string; dismiss?: boolean };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  if (body.dismiss) {
    const question = dismissQuestion(id);
    return question
      ? Response.json({ question, resumed: null })
      : Response.json({ error: `no open question ${id}` }, { status: 400 });
  }

  const answer = (body.answer ?? "").trim();
  if (!answer) {
    return Response.json({ error: "answer is required" }, { status: 400 });
  }

  const result = answerQuestion(id, answer.slice(0, 2000));
  if (!result) {
    return Response.json({ error: `no open question ${id}` }, { status: 400 });
  }
  return Response.json({
    question: result.question,
    resumed: result.resumed?.id ?? null,
  });
}
