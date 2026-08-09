/**
 * Server-side Convex access.
 *
 * The cockpit subscribes from the browser; this is the other direction — the
 * Node side of the app writing the log and reading it back on boot.
 *
 * Convex is optional at import time on purpose. Without `NEXT_PUBLIC_CONVEX_URL`
 * the brain still runs, it just runs in memory and says so, which is the same
 * degradation the old file-backed log had on a read-only filesystem. What it
 * must never do is fail to start.
 */

import { ConvexHttpClient } from "convex/browser";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;

let client: ConvexHttpClient | null = null;
if (url) {
  try {
    client = new ConvexHttpClient(url);
  } catch {
    client = null;
  }
}

export const convex = client;
export const convexConfigured = client !== null;

/** Why the brain isn't durable, in one line an operator can act on. */
export const convexNote = client
  ? `log on convex · ${new URL(url!).host}`
  : "NEXT_PUBLIC_CONVEX_URL unset — brain is in memory only, nothing survives a restart";
