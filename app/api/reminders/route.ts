import { NextResponse } from "next/server";
import { takeDue } from "@/lib/agent/reminders";
import { checkProactive } from "@/lib/agent/proactive";

export const runtime = "nodejs";

/** Polled by the ULTRON page every few seconds. Returns (and removes)
 *  whatever timers, reminders, or the daily briefing have come due, plus
 *  any proactive notices. POST because it changes state — and so the
 *  cross-site check in proxy.ts applies to it. */
export async function POST() {
  const [due, notices] = await Promise.all([takeDue(), checkProactive().catch(() => [])]);
  return NextResponse.json({ due: [...due, ...notices] });
}
