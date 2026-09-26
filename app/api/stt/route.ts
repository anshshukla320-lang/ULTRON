import { NextResponse } from "next/server";
import { findWhisper, transcribeWav } from "@/lib/agent/whisperStt";
import { getSettings } from "@/lib/agent/settings";
import { ownerScore, voiceIdStatus } from "@/lib/agent/voiceId";
import { detectWake, isStopCommand } from "@/lib/voiceCommands";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // ~2.5 min of 16 kHz mono audio

/** Which recognizer the page should use. */
export async function GET() {
  const settings = await getSettings();
  const installed = Boolean(await findWhisper());
  // Voice lock needs the audio itself, which only the Whisper path has.
  const wantWhisper = settings.sttEngine === "whisper" || settings.voiceLock;
  return NextResponse.json({
    engine: wantWhisper && installed ? "whisper" : "browser",
    language: settings.sttLanguage,
    whisperInstalled: installed,
    voiceLock: settings.voiceLock && installed && (await voiceIdStatus()).enrolled,
    presence: { enabled: settings.webcamPresence, lockMinutes: settings.presenceLockMinutes },
  });
}

/**
 * Body: a 16 kHz mono WAV recorded by the page. ?mode=wake while ULTRON is
 * waiting for "Hey ULTRON": the tiny model checks for the wake word first,
 * and only a real command gets the slower, more accurate pass.
 */
export async function POST(req: Request) {
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    return NextResponse.json({ error: "Expected a WAV file." }, { status: 400 });
  }
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: "Audio too long." }, { status: 413 });
  const wakeMode = new URL(req.url).searchParams.get("mode") === "wake";
  try {
    const settings = await getSettings();
    let text: string;
    if (wakeMode) {
      const quick = await transcribeWav(buf, settings.sttLanguage, { wake: true });
      const rest = detectWake(quick);
      if (rest === null || rest === "") {
        text = quick; // no wake word (the page ignores it), or the wake word alone
      } else {
        // Wake word plus a command in one breath: transcribe it properly.
        const full = await transcribeWav(buf, settings.sttLanguage);
        text = detectWake(full) === null ? `Hey Ultron, ${full}` : full;
      }
    } else {
      text = await transcribeWav(buf, settings.sttLanguage);
    }

    // Voice lock: someone who isn't the owner is simply not heard. Only
    // checked when there's something to act on (and wake-mode chatter
    // without the wake word never reaches the agent anyway).
    if (text && settings.voiceLock && (!wakeMode || detectWake(text) !== null)) {
      let score: number | null;
      try {
        score = await ownerScore(buf);
      } catch {
        // Too short to judge ("stop"): let a stop through, nothing else.
        score = isStopCommand(text) ? 1 : 0;
      }
      if (score !== null && score < settings.voiceLockThreshold) {
        return NextResponse.json({ text: "", rejected: true, score: Math.round(score * 100) / 100 });
      }
    }
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
