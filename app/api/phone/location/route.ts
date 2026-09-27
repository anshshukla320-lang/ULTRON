import { NextResponse } from "next/server";
import { savePhoneLocation } from "@/lib/agent/travel";

export const runtime = "nodejs";

/** From the phone app: its last known location, for travel times ("leave now"). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { lat?: unknown; lon?: unknown; accuracy?: unknown; at?: unknown } | null;
  try {
    const at = Number(body?.at);
    await savePhoneLocation(Number(body?.lat), Number(body?.lon), body?.accuracy !== undefined ? Number(body.accuracy) : undefined, Number.isFinite(at) && at > 0 && at <= Date.now() + 60_000 ? at : Date.now());
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
