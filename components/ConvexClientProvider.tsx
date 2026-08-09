"use client";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

/**
 * One client for the whole app. Convex pushes changes to every connected
 * browser, which is the part SSE off an in-memory bus cannot do once this is
 * deployed behind more than one server instance — and "two people watching
 * one brain" is the entire demo.
 *
 * `ConvexAuthProvider`, not a plain `ConvexProvider`: the plain one never
 * attaches a token to requests, so `getAuthUserId` comes back null on every
 * function and the app is silently signed out with no error anywhere.
 */
const url = process.env.NEXT_PUBLIC_CONVEX_URL;

if (!url) {
  throw new Error(
    "NEXT_PUBLIC_CONVEX_URL is not set. Run `npx convex dev` (it writes this " +
      "into .env.local), then restart the Next dev server so it picks it up.",
  );
}

const convex = new ConvexReactClient(url);

export default function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
}
