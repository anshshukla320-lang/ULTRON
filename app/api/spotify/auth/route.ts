import { NextResponse } from "next/server";
import { buildSpotifyAuthUrl } from "@/lib/agent/spotifyAuth";

export async function GET() {
  try {
    return NextResponse.redirect(buildSpotifyAuthUrl());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
