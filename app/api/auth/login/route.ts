import { NextResponse } from "next/server";
import { createSessionToken, timingSafeEqual, externalOrigin, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const expected = process.env.ULTRON_APP_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "ULTRON_APP_PASSWORD is not set in .env.local." }, { status: 500 });
  }

  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const origin = externalOrigin(req);

  if (!timingSafeEqual(password, expected)) {
    return NextResponse.redirect(new URL("/login?error=1", origin), { status: 303 });
  }

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
