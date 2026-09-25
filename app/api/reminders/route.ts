import { NextResponse } from "next/server";
import { takeDue } from "@/lib/agent/reminders";

export const runtime = "nodejs";

/** Polled by the ULTRON page every few seconds. Returns (and removes)
 *  whatever timers, reminders, or the daily briefing have come due. POST
 *  because it changes state — and so the cross-site check in proxy.ts
 *  applies to it. */
export async function POST() {
  return NextResponse.json({ due: await takeDue() });
}
