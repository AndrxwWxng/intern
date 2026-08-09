import { requireViewer } from "@/lib/auth";
import { cancel } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  ctx: RouteContext<"/api/interns/[id]">,
) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  const { id } = await ctx.params;
  // `cancel` returns false for both "no such intern" and "not yours", so a 404
  // is the same answer either way and reveals nothing about what exists.
  const ok = cancel(id, who.userId);
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
