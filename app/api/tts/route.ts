import { NextResponse } from "next/server";
import { isPiperAvailable, synthesizeWithPiper } from "@/lib/agent/piperTts";

export const runtime = "nodejs";

async function tryElevenLabs(text: string): Promise<NextResponse | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) return null;

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) return null;

  const audio = await res.arrayBuffer();
  return new NextResponse(audio, { headers: { "Content-Type": "audio/mpeg" } });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "text is required." }, { status: 400 });
  }

  // Piper first: local, offline, genuinely free forever — no credits, no
  // per-character cost, no internet needed once installed. ElevenLabs (if
  // configured and has credits) is a quality upgrade, not a requirement.
  if (await isPiperAvailable()) {
    try {
      const audio = await synthesizeWithPiper(text);
      return new NextResponse(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav" } });
    } catch (err) {
      console.error("Piper TTS failed, trying ElevenLabs next:", err);
    }
  }

  const elevenLabsResult = await tryElevenLabs(text).catch(() => null);
  if (elevenLabsResult) return elevenLabsResult;

  return NextResponse.json({ error: "No TTS backend available (Piper not installed, ElevenLabs not configured or failed)." }, { status: 500 });
}
