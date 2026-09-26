import { NextResponse } from "next/server";
import { findWhisper, transcribeWav } from "@/lib/agent/whisperStt";
import { getSettings } from "@/lib/agent/settings";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // ~2.5 min of 16 kHz mono audio

/** Which recognizer the page should use. */
export async function GET() {
  const settings = await getSettings();
  const installed = Boolean(await findWhisper());
  return NextResponse.json({
    engine: settings.sttEngine === "whisper" && installed ? "whisper" : "browser",
    language: settings.sttLanguage,
    whisperInstalled: installed,
  });
}

/** Body: a 16 kHz mono WAV recorded by the page. */
export async function POST(req: Request) {
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    return NextResponse.json({ error: "Expected a WAV file." }, { status: 400 });
  }
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: "Audio too long." }, { status: 413 });
  try {
    const { sttLanguage } = await getSettings();
    return NextResponse.json({ text: await transcribeWav(buf, sttLanguage) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
