import { NextResponse } from "next/server";
import { createSessionToken, timingSafeEqual, externalOrigin, safeNextPath, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth/session";
import { isLockedOut, recordLoginFailure, recordLoginSuccess, GLOBAL_MAX_ATTEMPTS } from "@/lib/auth/rateLimit";

export const runtime = "nodejs";

// x-forwarded-for is set by the tunnel, but a client connecting directly
// can put anything in it — so it's only a per-client hint. The global key
// below caps total guesses no matter how many fake addresses are used.
const GLOBAL_KEY = "*";

function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: Request) {
  const expected = process.env.ULTRON_APP_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "ULTRON_APP_PASSWORD is not set in .env.local." }, { status: 500 });
  }

  const origin = externalOrigin(req);
  const key = clientKey(req);

  const lockout = [isLockedOut(key), isLockedOut(GLOBAL_KEY)].find((l) => l.locked) ?? { locked: false, retryAfterMs: 0 };
  if (lockout.locked) {
    const minutes = Math.ceil(lockout.retryAfterMs / 60_000);
    return NextResponse.json({ error: `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.` }, { status: 429 });
  }

  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = safeNextPath(String(form.get("next") ?? ""));

  if (!timingSafeEqual(password, expected)) {
    recordLoginFailure(key);
    recordLoginFailure(GLOBAL_KEY, GLOBAL_MAX_ATTEMPTS);
    const retry = new URL("/login?error=1", origin);
    if (next !== "/") retry.searchParams.set("next", next);
    return NextResponse.redirect(retry, { status: 303 });
  }

  recordLoginSuccess(key);
  const token = await createSessionToken();
  const isHttps = req.headers.get("x-forwarded-proto") === "https";

  const res = NextResponse.redirect(new URL(next, origin), { status: 303 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
  return res;
}
