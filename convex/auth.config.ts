/**
 * Without this file `ctx.auth.getUserIdentity()` returns null forever and the
 * app is silently always-signed-out, with no error anywhere. It is the single
 * most common way Convex auth fails.
 *
 * CONVEX_SITE_URL is set automatically on every deployment.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
