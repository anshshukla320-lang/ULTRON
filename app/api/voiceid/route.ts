import { NextResponse } from "next/server";
import { enrollClip, identifySpeaker, listVoiceProfiles, resetVoiceId, voiceIdStatus, MIN_ENROLL_CLIPS, OWNER } from "@/lib/agent/voiceId";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ...(await voiceIdStatus()), needed: MIN_ENROLL_CLIPS, people: await listVoiceProfiles() });
}

/** ?action=enroll | test (body: WAV) | reset, and &name=<family member> (default: the owner). */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const name = url.searchParams.get("name")?.trim() || OWNER;
  try {
    if (action === "reset") {
      await resetVoiceId(name);
      return NextResponse.json({ ...(await voiceIdStatus()), needed: MIN_ENROLL_CLIPS, people: await listVoiceProfiles() });
    }
    const wav = Buffer.from(await req.arrayBuffer());
    if (wav.length > 5 * 1024 * 1024) return NextResponse.json({ error: "Clip too long." }, { status: 413 });
    if (action === "enroll") return NextResponse.json({ ...(await enrollClip(wav, name)), needed: MIN_ENROLL_CLIPS });
    if (action === "test") return NextResponse.json({ speaker: await identifySpeaker(wav) });
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
