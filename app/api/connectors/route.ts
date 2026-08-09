import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { requireViewer } from "@/lib/auth";
import { connectorStatus } from "@/lib/store";
import type { UserConnection } from "@/lib/connectors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * What can actually send, for the person asking.
 *
 * The connection list is read with the caller's own token against the
 * auth-scoped `connections.mine`, so this can only ever report grants that
 * belong to them. The panel used to be built from environment variables alone,
 * which meant it lit up green for everyone the moment an operator set a shared
 * credential — including people who had never linked anything.
 */
export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;

  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  let connections: UserConnection[] = [];
  if (url && token) {
    try {
      const client = new ConvexHttpClient(url);
      client.setAuth(token);
      connections = (await client.query(api.connections.mine, {})) as UserConnection[];
    } catch {
      // Unreachable Convex means we do not know what is connected. Reporting
      // nothing connected is the honest answer and the safe one: it can only
      // understate what you can do, never overstate it.
      connections = [];
    }
  }

  return Response.json(connectorStatus(connections));
}
