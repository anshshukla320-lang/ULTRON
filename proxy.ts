import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isValidSessionToken, externalOrigin, safeNextPath, SESSION_COOKIE } from "@/lib/auth/session";

// Reachable from the public tunnel with no login at all — Twilio verifies
// itself via request signature at the route level instead.
const TWILIO_WEBHOOK_PATHS = ["/api/call/twiml", "/api/call/gather"];
// Must stay reachable so a logged-out visitor can actually log in.
const AUTH_PATHS = ["/login", "/api/auth/login"];

// Every client needs the login cookie — including this PC. There used to be
// a no-login shortcut for requests whose Host header said "localhost", but
// Host is chosen by the client: any device on the LAN could send
// "Host: localhost:3000" and skip the password entirely. Proxy has no access
// to the real socket address, so there's no trustworthy way to tell "this
// PC" apart from anyone else; one login lasts 30 days.

/** Blocks cross-site form/fetch POSTs. A page on some other site can make
 *  the browser send a "simple" POST (e.g. text/plain) to localhost:3000 with
 *  no CORS preflight — req.json() would happily parse it and run tools.
 *  Browsers always attach Origin to cross-origin POSTs. */
function isCrossSite(req: NextRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false; // non-browser client (curl, Twilio) — no ambient cookies to abuse
  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    return true; // "null" origin (sandboxed iframe, file://)
  }
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (TWILIO_WEBHOOK_PATHS.some((p) => path.startsWith(p))) return NextResponse.next();

  if (isCrossSite(req)) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  if (AUTH_PATHS.some((p) => path.startsWith(p))) return NextResponse.next();

  let authenticated: boolean;
  try {
    authenticated = await isValidSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(`${msg} Set ULTRON_APP_PASSWORD and ULTRON_SESSION_SECRET in .env.local and restart.`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (authenticated) return NextResponse.next();

  if (path.startsWith("/api/") && !path.endsWith("/callback")) {
    return NextResponse.json({ error: "Not authenticated. Sign in at /login." }, { status: 401 });
  }
  // OAuth callbacks land here via a browser redirect — send them through
  // login and back, so the ?code= isn't lost (e.g. Spotify's callback is on
  // 127.0.0.1, which doesn't share cookies with localhost).
  const loginUrl = new URL("/login", externalOrigin(req));
  const next = safeNextPath(`${path}${req.nextUrl.search}`);
  if (next !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
