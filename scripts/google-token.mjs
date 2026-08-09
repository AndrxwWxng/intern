#!/usr/bin/env node
/**
 * Mint a Google refresh token for the Gmail and Calendar connectors.
 *
 * Run once. It opens a consent screen, catches the redirect on localhost,
 * trades the code for tokens, and prints the refresh token to paste into
 * .env.local. Nothing is written to disk and nothing leaves your machine
 * except the exchange with Google.
 *
 *   node scripts/google-token.mjs <client-id> <client-secret>
 *
 * Requires an OAuth client of type "Desktop app" — that type is what permits
 * the loopback redirect this script listens on.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

const clientId = process.argv[2] ?? process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.argv[3] ?? process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(`
Usage: node scripts/google-token.mjs <client-id> <client-secret>

Get both from Google Cloud Console → APIs & Services → Credentials →
Create Credentials → OAuth client ID → Application type: Desktop app.
`);
  process.exit(1);
}

const PORT = 4517; // arbitrary, just needs to be free and unused elsewhere
const redirectUri = `http://localhost:${PORT}`;

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // offline + consent together are what guarantee a refresh token comes
    // back. Without prompt=consent Google omits it on repeat authorisations.
    access_type: "offline",
    prompt: "consent",
  });

const page = (title, detail) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:14px ui-monospace,monospace;background:#08090a;color:#e4e6e9;padding:3rem">` +
  `<h1 style="font-size:15px;font-weight:400">${title}</h1>` +
  `<p style="color:#797f88">${detail}</p></body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(page("Denied", `Google said: ${error}`));
    console.error(`\n✗ ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(page("Waiting", "No code on this request."));
    return;
  }

  const token = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = await token.json().catch(() => ({}));

  if (!token.ok || !data.refresh_token) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(page("Exchange failed", "Check the terminal."));
    console.error(
      `\n✗ ${data.error_description ?? data.error ?? token.status}` +
        (data.access_token && !data.refresh_token
          ? "\n  Got an access token but no refresh token — revoke this app at" +
            "\n  myaccount.google.com/permissions and run again."
          : ""),
    );
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page("Done", "Token is in your terminal. You can close this tab."));

  console.log(`
✓ Paste this into .env.local

GOOGLE_CLIENT_ID=${clientId}
GOOGLE_CLIENT_SECRET=${clientSecret}
GOOGLE_REFRESH_TOKEN=${data.refresh_token}

Scopes granted: ${SCOPES.join(", ")}
`);
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`\nOpening Google consent for:\n  ${SCOPES.join("\n  ")}\n`);
  console.log(`If no browser opens, visit:\n${authUrl}\n`);
  // macOS `open`; harmless if it isn't there.
  spawn("open", [authUrl], { stdio: "ignore" }).on("error", () => {});
});
