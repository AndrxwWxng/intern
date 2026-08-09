"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

/**
 * One client for the whole app. Convex pushes changes to every connected
 * browser, which is the part SSE off an in-memory bus cannot do once this is
 * deployed behind more than one server instance — and "two people watching
 * one brain" is the entire demo.
 */
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export default function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
