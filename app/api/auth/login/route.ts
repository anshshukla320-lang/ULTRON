import { NextResponse } from "next/server";
import { createSessionToken, timingSafeEqual, externalOrigin, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth/session";
import { isLockedOut, recordLoginFailure, recordLoginSuccess } from "@/lib/auth/rateLimit";

export const runtime = "nodejs";

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

  const lockout = isLockedOut(key);
  if (lockout.locked) {
    const minutes = Math.ceil(lockout.retryAfterMs / 60_000);
    return NextResponse.json({ error: `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.` }, { status: 429 });
  }

  const form = await req.formData();
  const password = String(form.get("password") ?? "");

  if (!timingSafeEqual(password, expected)) {
    recordLoginFailure(key);
    return NextResponse.redirect(new URL("/login?error=1", origin), { status: 303 });
  }

  recordLoginSuccess(key);
  const token = await createSessionToken();
  const isHttps = req.headers.get("x-forwarded-proto") === "https";

  const res = NextResponse.redirect(new URL("/", origin), { status: 303 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
  return res;
}
