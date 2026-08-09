import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "./_generated/server";

/**
 * Who the caller is, derived server-side from the token.
 *
 * This is the one place the Node half of the app can ask Convex "whose request
 * is this?" — `lib/auth.ts` calls it with the browser's bearer token so an API
 * route can scope work to an owner without trusting anything the client said
 * about itself. Deriving it here rather than decoding the JWT in Next keeps a
 * single verifier: if Convex won't honour the token, neither will we.
 */
export const viewer = query({
  args: {},
  returns: v.union(
    v.object({
      userId: v.id("users"),
      email: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get("users", userId);
    return { userId, email: user?.email ?? null };
  },
});
