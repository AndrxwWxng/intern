/**
 * A Slack reply, arriving as an answer.
 *
 * Convex owns the Slack side — it holds the tokens and verifies Slack's
 * request signature — but questions live in this process's memory, so the last
 * hop has to come back here. Convex has already established *who* replied from
 * the `U…` on the event and the connection row only that person could have
 * written; this route trusts that, and nothing else.
 *
 * The shared secret is what makes that trust safe: without it, anyone who
 * could reach this URL could answer anyone's question, which would put a
 * forged fact in the brain and dispatch an intern to act on it.
 */

import { answerQuestion } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Constant-time compare — `===` leaks the secret's prefix through timing. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request: Request): boolean {
  const expected = process.env.INTERN_SERVICE_SECRET;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer") return false;
  return secretsMatch(rest.join(" ").trim(), expected);
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  let body: { userId?: unknown; questionId?: unknown; answer?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const userId = typeof body.userId === "string" ? body.userId : "";
  const questionId = typeof body.questionId === "string" ? body.questionId : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";

  if (!userId || !questionId || !answer) {
    return Response.json(
      { error: "userId, questionId and answer are required" },
      { status: 400 },
    );
  }

  // `answerQuestion` re-checks ownership against the question it finds, so a
  // caller that got the routing wrong cannot answer across accounts even
  // holding the service secret.
  const result = answerQuestion(questionId, answer.slice(0, 2000), "slack", userId);
  if (!result) {
    return Response.json(
      { error: `no open question ${questionId} for that account` },
      { status: 404 },
    );
  }

  return Response.json({
    question: result.question.id,
    resumed: result.resumed?.id ?? null,
  });
}
