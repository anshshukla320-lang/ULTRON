import { NextResponse } from "next/server";
import { enrollClip, ownerScore, resetVoiceId, voiceIdStatus, MIN_ENROLL_CLIPS } from "@/lib/agent/voiceId";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ...(await voiceIdStatus()), needed: MIN_ENROLL_CLIPS });
}

/** ?action=enroll | test (body: WAV) | reset. */
export async function POST(req: Request) {
  const action = new URL(req.url).searchParams.get("action");
  try {
    if (action === "reset") {
      await resetVoiceId();
      return NextResponse.json({ ...(await voiceIdStatus()), needed: MIN_ENROLL_CLIPS });
    }
    const wav = Buffer.from(await req.arrayBuffer());
    if (wav.length > 5 * 1024 * 1024) return NextResponse.json({ error: "Clip too long." }, { status: 413 });
    if (action === "enroll") return NextResponse.json({ ...(await enrollClip(wav)), needed: MIN_ENROLL_CLIPS });
    if (action === "test") return NextResponse.json({ score: await ownerScore(wav) });
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
