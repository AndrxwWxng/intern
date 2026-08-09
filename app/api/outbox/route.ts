import { listActions } from "@/lib/store";
import type { ActionStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status");
  return Response.json({
    actions: listActions((status as ActionStatus) || undefined),
  });
}
