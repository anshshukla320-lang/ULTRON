import { NextResponse } from "next/server";
import { getPhoneSession, endPhoneSession, MAX_TURNS } from "@/lib/agent/phoneSession";
import { runPhoneTurn } from "@/lib/agent/phoneAgent";
import { sayAndGather, sayAndHangup } from "@/lib/agent/twimlHelpers";
import { verifyTwilioSignature } from "@/lib/agent/twilioVerify";

export const runtime = "nodejs";

function xml(body: string) {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const form = new URLSearchParams(rawBody);

  if (!verifyTwilioSignature(req, form)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const callSid = form.get("CallSid") ?? "";
  const speech = (form.get("SpeechResult") ?? "").trim();

  if (!speech) {
    endPhoneSession(callSid);
    return xml(sayAndHangup("Didn't catch a follow-up. Talk soon."));
  }

  const session = getPhoneSession(callSid);
  if (!session) {
    return xml(sayAndHangup("This call session expired. Ask Ultron to call again."));
  }

  session.turns += 1;
  let reply: string;
  try {
    const result = await runPhoneTurn(session.messages, speech);
    session.messages = result.messages;
    reply = result.reply;
  } catch (err) {
    console.error("phone gather turn failed:", err);
    reply = "Sorry, I hit an error on that one.";
  }

  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

  if (session.turns >= MAX_TURNS) {
    endPhoneSession(callSid);
    return xml(sayAndHangup(`${reply} That's all for this call — talk soon.`));
  }

  return xml(sayAndGather(reply, `${publicUrl}/api/call/gather`));
}
