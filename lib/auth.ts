/**
 * Who is calling an API route.
 *
 * The cockpit holds a Convex auth token in the browser; every request to
 * `/api/*` carries it as `Authorization: Bearer …` and this module turns it
 * back into a user id by asking Convex. Convex is the only verifier — decoding
 * the JWT here would mean two implementations of "is this token good", and the
 * second one is always the one that gets it wrong.
 *
 * Nothing the client says about itself is trusted. The token is the only input.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export type Viewer = { userId: string; email: string | null };

const url = process.env.NEXT_PUBLIC_CONVEX_URL;

/**
 * Verified tokens, briefly. A round trip per request would put Convex in the
 * path of every keystroke-driven fetch; a minute of staleness only means a
 * just-signed-out token keeps working for up to a minute, and the token itself
 * outlives that anyway.
 */
const verified = new Map<string, { viewer: Viewer; at: number }>();
const TTL_MS = 60_000;
const CACHE_CAP = 500;

function remember(token: string, viewer: Viewer) {
  // Oldest-first eviction, so a long-lived process can't grow this without
  // bound just because tokens rotate.
  if (verified.size >= CACHE_CAP) {
    const oldest = verified.keys().next().value;
    if (oldest) verified.delete(oldest);
  }
  verified.set(token, { viewer, at: Date.now() });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  const token = rest.join(" ").trim();
  return scheme.toLowerCase() === "bearer" && token ? token : null;
}

/** The caller, or null if the request carried no usable token. */
export async function viewerFor(request: Request): Promise<Viewer | null> {
  const token = bearer(request);
  if (!token || !url) return null;

  const hit = verified.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.viewer;
  verified.delete(token);

  try {
    const client = new ConvexHttpClient(url);
    client.setAuth(token);
    const result = await client.query(api.users.viewer, {});
    if (!result) return null;

    const viewer: Viewer = { userId: result.userId, email: result.email };
    remember(token, viewer);
    return viewer;
  } catch {
    // A rejected token and an unreachable Convex are the same answer here:
    // we could not establish who this is, so the request gets nothing.
    return null;
  }
}

export const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });

/**
 * `viewerFor` or a 401, in the shape route handlers want:
 *
 *   const who = await requireViewer(request);
 *   if (who instanceof Response) return who;
 */
export async function requireViewer(request: Request): Promise<Viewer | Response> {
  return (await viewerFor(request)) ?? unauthorized();
}
