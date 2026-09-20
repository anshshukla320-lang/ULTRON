import { NextResponse } from "next/server";
import { takeCallScript } from "@/lib/agent/callCache";
import { initPhoneSession } from "@/lib/agent/phoneSession";
import { sayAndGather } from "@/lib/agent/twimlHelpers";
import { verifyTwilioSignature } from "@/lib/agent/twilioVerify";

export const runtime = "nodejs";

function xml(body: string) {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);

  if (!verifyTwilioSignature(req, params)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const token = new URL(req.url).searchParams.get("token") ?? "";
  const callSid = params.get("CallSid") ?? "";
  const script = takeCallScript(token) ?? "This report has expired. Ask Ultron to call again.";

  if (callSid) initPhoneSession(callSid, script);

  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return xml(sayAndGather(script, `${publicUrl}/api/call/gather`));
}
