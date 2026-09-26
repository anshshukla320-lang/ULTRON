import { NextResponse } from "next/server";
import { takeDue } from "@/lib/agent/reminders";
import { checkProactive } from "@/lib/agent/proactive";
import { markPageActive } from "@/lib/agent/presence";

export const runtime = "nodejs";

/** Polled by the ULTRON page every few seconds. Returns (and removes)
 *  whatever timers, reminders, or the daily briefing have come due, plus
 *  any proactive notices. POST because it changes state — and so the
 *  cross-site check in proxy.ts applies to it. */
export async function POST() {
  // Tells the background loop a page is open, so it leaves announcing to it.
  await markPageActive();
  const [due, notices] = await Promise.all([takeDue(), checkProactive().catch(() => [])]);
  return NextResponse.json({ due: [...due, ...notices] });
}
