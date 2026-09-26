import { NextResponse } from "next/server";
import { getSettings } from "@/lib/agent/settings";
import { lockPc } from "@/lib/agent/pcControls";

export const runtime = "nodejs";

/** From the page's webcam presence watcher: the user has been away long
 *  enough — lock the PC if that's switched on. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { event?: string; awayMinutes?: number } | null;
  if (body?.event !== "away") return NextResponse.json({ error: "Unknown event." }, { status: 400 });
  const s = await getSettings();
  if (!s.webcamPresence || s.presenceLockMinutes <= 0) return NextResponse.json({ locked: false });
  if ((body.awayMinutes ?? 0) < s.presenceLockMinutes) return NextResponse.json({ locked: false });
  try {
    await lockPc();
    return NextResponse.json({ locked: true });
  } catch (err) {
    return NextResponse.json({ locked: false, error: err instanceof Error ? err.message : String(err) });
  }
}
