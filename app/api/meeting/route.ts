import { NextResponse } from "next/server";
import { activeMeeting, startMeeting, stopMeeting } from "@/lib/agent/meetings";
import { findWhisper } from "@/lib/agent/whisperStt";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ active: await activeMeeting() });
}

/** {action: "start", title} | {action: "stop"} — used by the phone app. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: string; title?: string } | null;
  try {
    if (body?.action === "start") {
      if (!(await findWhisper())) return NextResponse.json({ error: "Meeting notes need local Whisper on the PC (scripts\\install-whisper.ps1)." }, { status: 503 });
      const m = await startMeeting(body.title ?? "");
      return NextResponse.json({ id: m.id, title: m.title });
    }
    if (body?.action === "stop") return NextResponse.json(await stopMeeting());
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
