import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { consolidateConversation } from "@/lib/agent/episodes";

export const runtime = "nodejs";

/** Called by the page when a conversation ends (it goes quiet, or the tab
 *  closes) with the messages since the last call. */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set." }, { status: 500 });
  const body = await req.json().catch(() => null);
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages) return NextResponse.json({ error: "messages must be an array." }, { status: 400 });
  try {
    const result = await consolidateConversation(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), messages);
    return NextResponse.json({ saved: Boolean(result.episode), factsAdded: result.factsAdded });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
