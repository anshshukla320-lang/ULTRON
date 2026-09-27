import { NextResponse } from "next/server";
import { noticesAfter } from "@/lib/agent/noticeLog";

export const runtime = "nodejs";

/** For the phone app: announcements it hasn't shown yet (?after=<seq>). */
export async function GET(req: Request) {
  const after = Number(new URL(req.url).searchParams.get("after") ?? "0");
  return NextResponse.json(await noticesAfter(Number.isFinite(after) ? after : 0));
}
