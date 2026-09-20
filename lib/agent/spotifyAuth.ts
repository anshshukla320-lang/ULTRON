import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Stored outside the agent's file-tool workspace on purpose — same reasoning
// as gmail-token.json: read_file/list_files/search_files are scoped to
// WORKSPACE_ROOT and must never be able to reach this token.
const CONFIG_DIR = path.join(os.homedir(), ".ultron");
const TOKEN_PATH = path.join(CONFIG_DIR, "spotify-token.json");

const SCOPES = ["user-modify-playback-state", "user-read-playback-state", "user-read-currently-playing"];

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

export async function isSpotifyConnected(): Promise<boolean> {
  return (await readToken()) !== null;
}

export async function disconnectSpotify(): Promise<void> {
  try {
    await fs.unlink(TOKEN_PATH);
  } catch {
    // already disconnected
  }
}

function requireOAuthConfig() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:3000/api/spotify/callback";
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set in .env.local.");
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildSpotifyAuthUrl(): string {
  const { clientId, redirectUri } = requireOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig();
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams({ code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) {
    throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  if (!data.refresh_token) {
    throw new Error("Spotify didn't return a refresh token — try connecting again.");
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
    throw new Error("Spotify isn't connected. Visit /api/spotify/auth in your browser to connect it first.");
  }
  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 30_000) {
    return token.access_token;
  }

  const { clientId, clientSecret } = requireOAuthConfig();
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams({ refresh_token: token.refresh_token, grant_type: "refresh_token" }),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh Spotify access token: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  await writeToken({
    refresh_token: data.refresh_token ?? token.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
