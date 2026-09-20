import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Stored outside the agent's file-tool workspace on purpose: read_file /
// list_files / search_files are scoped to WORKSPACE_ROOT and must never be
// able to reach this token, however the request was phrased.
const CONFIG_DIR = path.join(os.homedir(), ".ultron");
const TOKEN_PATH = path.join(CONFIG_DIR, "gmail-token.json");

interface StoredToken {
  refresh_token: string;
  access_token?: string;
  expires_at?: number; // epoch ms
}

async function readToken(): Promise<StoredToken | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

async function writeToken(token: StoredToken): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), "utf-8");
}

export async function isGmailConnected(): Promise<boolean> {
  return (await readToken()) !== null;
}

export async function disconnectGmail(): Promise<void> {
  try {
    await fs.unlink(TOKEN_PATH);
  } catch {
    // already disconnected
  }
}

function requireOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/api/gmail/callback";
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in .env.local.");
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildGoogleAuthUrl(): string {
  const { clientId, redirectUri } = requireOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"].join(" "),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig();
  const res = await fetch("https://oauth2.googleapis.com/token", {
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
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  if (!data.refresh_token) {
    throw new Error("Google didn't return a refresh token — revoke ULTRON's access in your Google Account and try connecting again.");
  }
  await writeToken({
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
}

export async function getAccessToken(): Promise<string> {
  const token = await readToken();
  if (!token) {
    throw new Error("Gmail isn't connected. Visit /api/gmail/auth in your browser to connect it first.");
  }
  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 30_000) {
    return token.access_token;
  }

  const { clientId, clientSecret } = requireOAuthConfig();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh Gmail access token: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  await writeToken({
    refresh_token: token.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
