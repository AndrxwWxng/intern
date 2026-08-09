import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * Email + password.
 *
 * Passkeys would be nicer, but `@convex-dev/auth@0.0.94` doesn't ship a
 * Passkey provider — the built-ins are Password, Email, Phone, Anonymous and
 * ConvexCredentials. Password is also the least friction for the demo that
 * matters: two people signing in on two machines against one shared brain.
 *
 * To add Google later: `import Google from "@auth/core/providers/google"` and
 * put it in this array. Nothing else changes.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password()],
});
