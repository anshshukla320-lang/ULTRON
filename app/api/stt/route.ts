import { NextResponse } from "next/server";
import { findWhisper, transcribeWav } from "@/lib/agent/whisperStt";
import { getSettings } from "@/lib/agent/settings";
import { identifySpeaker, listVoiceProfiles, OWNER, voiceIdStatus } from "@/lib/agent/voiceId";
import { detectWake, isStopCommand } from "@/lib/voiceCommands";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // ~2.5 min of 16 kHz mono audio

/** Which recognizer the page should use. */
export async function GET() {
  const settings = await getSettings();
  const installed = Boolean(await findWhisper());
  // Voice lock needs the audio itself, which only the Whisper path has.
  // Family mode (telling voices apart) needs it too.
  const family = (await listVoiceProfiles()).filter((p) => p.key !== OWNER && p.enrolled).length > 0;
  const wantWhisper = settings.sttEngine === "whisper" || settings.voiceLock || family;
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

    // Who's speaking (voice lock and family mode). Only checked when there's
    // something to act on — wake-mode chatter without the wake word never
    // reaches the agent anyway.
    let speaker: { key: string; name: string } | undefined;
    const profiles = (await listVoiceProfiles()).filter((p) => p.enrolled);
    if (text && profiles.length && (!wakeMode || detectWake(text) !== null)) {
      let best: { key: string; name: string; score: number } | null = null;
      let tooShort = false;
      try {
        best = await identifySpeaker(buf);
      } catch {
        tooShort = true;
      }
      if (best && best.score >= settings.voiceLockThreshold) speaker = { key: best.key, name: best.name };
      // Voice lock: someone ULTRON doesn't know is simply not heard. A clip too
      // short to judge ("stop") may still stop it, nothing else.
      if (settings.voiceLock && !speaker && !(tooShort && isStopCommand(text))) {
        return NextResponse.json({ text: "", rejected: true, score: best ? Math.round(best.score * 100) / 100 : null });
      }
    }
    return NextResponse.json({ text, ...(speaker ? { speaker } : {}) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
