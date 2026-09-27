import { NextResponse } from "next/server";
import { recordIntruder } from "@/lib/agent/security";

export const runtime = "nodejs";

/** A webcam snapshot (JPEG body) from the PC page while security mode is on. */
export async function POST(req: Request) {
  const jpeg = Buffer.from(await req.arrayBuffer());
  if (jpeg.length > 2 * 1024 * 1024) return NextResponse.json({ error: "Photo too large." }, { status: 413 });
  try {
    return NextResponse.json({ sent: await recordIntruder(jpeg) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
