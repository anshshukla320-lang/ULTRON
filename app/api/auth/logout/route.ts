import { NextResponse } from "next/server";
import { SESSION_COOKIE, externalOrigin } from "@/lib/auth/session";

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/login", externalOrigin(req)), { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
