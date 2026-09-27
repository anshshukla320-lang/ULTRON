import { NextResponse } from "next/server";
import { addMeetingChunk } from "@/lib/agent/meetings";

export const runtime = "nodejs";

/** A recorded chunk of the meeting: 16 kHz mono WAV. ?id=…&final=1 for the last one. */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const wav = Buffer.from(await req.arrayBuffer());
  if (wav.length > 8 * 1024 * 1024) return NextResponse.json({ error: "Chunk too long." }, { status: 413 });
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") return NextResponse.json({ error: "Expected a WAV file." }, { status: 400 });
  try {
    return NextResponse.json(await addMeetingChunk(id, wav, undefined, url.searchParams.get("final") === "1"));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
