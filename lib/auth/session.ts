export const SESSION_COOKIE = "ultron_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toHex(sig);
}

// Constant-time compare — avoids leaking the token via response-time
// differences. Plain string equality would short-circuit on the first
// mismatched character.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireSecret(): string {
  const secret = process.env.ULTRON_SESSION_SECRET;
  if (!secret) throw new Error("ULTRON_SESSION_SECRET is not set in .env.local.");
  return secret;
}

export async function createSessionToken(): Promise<string> {
  const secret = requireSecret();
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(secret, String(exp));
  return `${exp}.${sig}`;
}

// Route Handlers' req.url can be reconstructed from mismatched forwarded
// headers behind the tunnel (protocol from one header, host from another),
// producing a broken absolute URL. The Host header the client actually sent
// is the one value guaranteed to be the real externally-visible origin.
export function externalOrigin(req: Request): string {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function isValidSessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const [expStr, sig] = token.split(".");
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const secret = requireSecret();
  const expected = await hmacHex(secret, expStr);
  return timingSafeEqual(sig, expected);
}
