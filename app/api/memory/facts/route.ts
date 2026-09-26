import { NextResponse } from "next/server";
import { listFacts, rememberNewFacts } from "@/lib/agent/memory";

export const runtime = "nodejs";

/** For the phone app: what ULTRON knows about the user, so its own brain
 *  can use it while the PC is unreachable. */
export async function GET() {
  return NextResponse.json({ facts: (await listFacts()).map((f) => f.text) });
}

/** Facts the phone learned while the PC was off, synced back. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { facts?: unknown } | null;
  const facts = Array.isArray(body?.facts) ? body.facts.map(String).map((f) => f.trim()).filter((f) => f && f.length <= 500).slice(0, 50) : [];
  // Skips anything already known (the phone may resend after a dropped reply).
  return NextResponse.json({ added: await rememberNewFacts(facts) });
}
