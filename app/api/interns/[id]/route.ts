import { cancel } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/interns/[id]">,
) {
  const { id } = await ctx.params;
  const ok = cancel(id);
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
