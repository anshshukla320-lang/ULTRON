import { NextResponse } from "next/server";
import { takeDue } from "@/lib/agent/reminders";
import { checkProactive } from "@/lib/agent/proactive";
import { markPageActive } from "@/lib/agent/presence";
import { takeFocusDue } from "@/lib/agent/focus";
import { lineFor, logNotices } from "@/lib/agent/noticeLog";

export const runtime = "nodejs";

/** Polled by the ULTRON page every few seconds. Returns (and removes)
 *  whatever timers, reminders, or the daily briefing have come due, plus
 *  any proactive notices. POST because it changes state — and so the
 *  cross-site check in proxy.ts applies to it. */
export async function POST() {
  // Tells the background loop a page is open, so it leaves announcing to it.
  await markPageActive();
  const [due, notices, focus] = await Promise.all([takeDue(), checkProactive().catch(() => []), takeFocusDue().catch(() => [])]);
  const all = [...due, ...focus, ...notices];
  // The page is about to say these; the phone gets them as notifications too.
  await logNotices(all.map((i) => ({ kind: i.kind, text: lineFor(i) }))).catch(() => {});
  return NextResponse.json({ due: all });
}
