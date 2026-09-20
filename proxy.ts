import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isValidSessionToken, externalOrigin, SESSION_COOKIE } from "@/lib/auth/session";

// Reachable from the public tunnel with no login at all — Twilio verifies
// itself via request signature at the route level instead.
const TWILIO_WEBHOOK_PATHS = ["/api/call/twiml", "/api/call/gather"];
// Must stay reachable so a logged-out visitor can actually log in.
const AUTH_PATHS = ["/login", "/api/auth/login"];

function isLocalHost(hostHeader: string): boolean {
  const host = hostHeader.split(":")[0];
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export async function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  // At home, on this PC or its own LAN, Ultron is trusted with no login —
  // same as before. The password gate only applies to the public tunnel.
  if (isLocalHost(host)) return NextResponse.next();

  const path = req.nextUrl.pathname;
  if (TWILIO_WEBHOOK_PATHS.some((p) => path.startsWith(p))) return NextResponse.next();
  if (AUTH_PATHS.some((p) => path.startsWith(p))) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (await isValidSessionToken(token)) return NextResponse.next();

  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated. Sign in at /login." }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", externalOrigin(req)));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
