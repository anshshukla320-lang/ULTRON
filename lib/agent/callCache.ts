import crypto from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const scripts = new Map<string, { script: string; expiresAt: number }>();

function sweep() {
  const now = Date.now();
  for (const [token, entry] of scripts) {
    if (entry.expiresAt < now) scripts.delete(token);
  }
}

export function stashCallScript(script: string): string {
  sweep();
  const token = crypto.randomBytes(16).toString("hex");
  scripts.set(token, { script, expiresAt: Date.now() + TTL_MS });
  return token;
}

// Doesn't delete on read: Twilio may retry the webhook fetch if the first
// attempt is slow, so the script needs to survive more than one GET. The TTL
// sweep in stashCallScript/here is what actually reclaims memory.
export function takeCallScript(token: string): string | null {
  sweep();
  return scripts.get(token)?.script ?? null;
}
