/**
 * Google OAuth — shared by the Gmail and Calendar connectors.
 *
 * Installed-app refresh-token flow: you authorise once, store the refresh
 * token, and Intern trades it for short-lived access tokens. No service
 * account, because sending mail *as a person* needs that person's grant.
 *
 * Scopes to request when minting the refresh token:
 *   https://www.googleapis.com/auth/gmail.send
 *   https://www.googleapis.com/auth/calendar.events
 */

let cached: { token: string; expiresAt: number } | null = null;

export const googleConfigured = () =>
  Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN,
  );

export async function googleAccessToken(): Promise<string> {
  // 60s of slack so a token can't expire mid-request.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN ?? "",
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(
      `google token refresh failed: ${data.error_description ?? data.error ?? res.status}`,
    );
  }

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Drop the cached token — used when a call comes back 401. */
export const invalidateGoogleToken = () => {
  cached = null;
};
