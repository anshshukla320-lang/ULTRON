import { NextResponse } from "next/server";
import { phoneAway } from "@/lib/agent/security";
import { getSettings } from "@/lib/agent/settings";

export const runtime = "nodejs";

/** From the phone app: {away: true} when it leaves the saved "home" place, false when back. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { away?: unknown } | null;
  if (typeof body?.away !== "boolean") return NextResponse.json({ error: "Send {away: true|false}." }, { status: 400 });
  return NextResponse.json({ result: await phoneAway(body.away, (await getSettings()).securityWhenAway) });
}
