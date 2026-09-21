import { NextResponse } from "next/server";
import { buildGoogleAuthUrl } from "@/lib/agent/googleAuth";

export async function GET() {
  try {
    return NextResponse.redirect(buildGoogleAuthUrl());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
