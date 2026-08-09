import { requireViewer } from "@/lib/auth";
import { getGraph, probe, refreshGraph, visibleGraph } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The brain is shared — that is the product. But the working interns, parked
 * questions and pending drafts grafted onto it are not, so what goes out is
 * always the viewer's own view of it.
 */
export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!refresh) {
    return Response.json({ graph: visibleGraph(getGraph(), who.userId) });
  }
  await probe(true);
  return Response.json({
    graph: visibleGraph(await refreshGraph(), who.userId),
  });
}
