import { NextResponse } from "next/server";
import { listRemindersRaw } from "@/lib/agent/reminders";
import { listRoutinesRaw, routineNeedsConfirmation } from "@/lib/agent/routines";
import { TOOL_POLICY } from "@/lib/agent/tools";
import { noticesAfter } from "@/lib/agent/noticeLog";

export const runtime = "nodejs";

/** For the phone's home-screen widget: what's next, and one-tap routines. */
export async function GET() {
  const { items } = await listRemindersRaw();
  const upcoming = items
    .filter((r) => r.kind !== "notice")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .slice(0, 3)
    .map((r) => ({ kind: r.kind, text: r.text, dueAt: r.dueAt }));
  const routines = listRoutinesRaw()
    // Only ones that can run with a tap (no confirmation needed).
    .filter((r) => !routineNeedsConfirmation(r.name, TOOL_POLICY))
    .map((r) => r.name);
  return NextResponse.json({ upcoming, routines, latestNotice: (await noticesAfter(0, 0)).latest });
}
