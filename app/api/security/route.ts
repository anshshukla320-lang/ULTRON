import { NextResponse } from "next/server";
import { securityState, setSecurityMode } from "@/lib/agent/security";

export const runtime = "nodejs";

/** Is security mode on? (The PC page asks when it opens.) */
export async function GET() {
  const s = await securityState();
  return NextResponse.json({ on: s.on, since: s.since ?? null, away: s.away });
}

/** {on: boolean} — from the settings page or the phone app. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return NextResponse.json({ error: "Send {on: true|false}." }, { status: 400 });
  return NextResponse.json({ result: await setSecurityMode(body.on, "page") });
}
