import { NextResponse } from "next/server";
import { saveHealth } from "@/lib/agent/health";

export const runtime = "nodejs";

/** The phone uploads recent days from Health Connect. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { days?: unknown } | null;
  return NextResponse.json({ saved: await saveHealth(body?.days) });
}
