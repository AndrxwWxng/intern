import { requireViewer } from "@/lib/auth";
import { connectorStatus } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  return Response.json(connectorStatus());
}
