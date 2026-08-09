import { requireViewer } from "@/lib/auth";
import { capture } from "@/lib/store";
import type { FactKind } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KINDS: FactKind[] = [
  "note",
  "decision",
  "preference",
  "correction",
  "answer",
  "person",
  "project",
];

/**
 * The pushed ingestion path: someone points at something and it lands in the
 * brain. Idempotent on `(source, external_id)`, so a client that retries or
 * fires twice produces one observation and one fact.
 */
export async function POST(request: Request) {
  // The fact lands in the shared brain either way; the archivist that `file`
  // dispatches is an intern, and an intern needs an owner.
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  let body: {
    title?: string;
    body?: string;
    source?: string;
    external_id?: string;
    actor?: string;
    url?: string;
    tags?: string[];
    kind?: string;
    file?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const title = (body.title ?? "").trim();
  const text = (body.body ?? "").trim();
  if (!title && !text) {
    return Response.json(
      { error: "title or body is required" },
      { status: 400 },
    );
  }

  const result = await capture({
    sourceId: (body.source ?? "capture").trim() || "capture",
    externalId: body.external_id,
    actor: body.actor,
    title: title || text.slice(0, 80),
    body: text,
    url: body.url,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 8) : undefined,
    kind: KINDS.includes(body.kind as FactKind)
      ? (body.kind as FactKind)
      : undefined,
    file: body.file === true,
    ownerId: who.userId,
  });

  return Response.json(
    {
      fact: result.fact,
      fresh: result.fresh,
      merged: result.merged,
      intern: result.intern?.id ?? null,
    },
    { status: result.fresh ? 201 : 200 },
  );
}
