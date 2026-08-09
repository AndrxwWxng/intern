import { getGraph, probe, refreshGraph } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!refresh) return Response.json({ graph: getGraph() });
  await probe(true);
  return Response.json({ graph: await refreshGraph() });
}
