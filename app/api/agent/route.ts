import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { recallMemoryForPrompt } from "@/lib/agent/memory";
import { runAgent, type AgentStart } from "@/lib/agent/runAgent";
import { buildSystemBlocks } from "@/lib/agent/systemPrompt";
import { recentEpisodesForPrompt } from "@/lib/agent/episodes";
import { describeSignals, parseSignals } from "@/lib/agent/signals";
import { getSettings } from "@/lib/agent/settings";
import { spentToday } from "@/lib/agent/usage";
import { parseClientTools, PHONE_CHANNEL_NOTE } from "@/lib/agent/clientTools";

export const runtime = "nodejs";

/**
 * Streams the agent's progress as newline-delimited JSON (one AgentEvent
 * per line): "text" chunks as Claude writes them — so the browser can start
 * speaking the first sentence before the reply is finished — "action"
 * entries as tools run, and a final "done" (or "error").
 */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart the dev server." },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const settings = await getSettings();
  if (settings.dailyBudgetUsd > 0 && (await spentToday()) >= settings.dailyBudgetUsd) {
    return NextResponse.json(
      { error: `Today's Claude budget of $${settings.dailyBudgetUsd.toFixed(2)} is used up. Raise it in Settings to continue.` },
      { status: 429 },
    );
  }

  const start: AgentStart = body.resolution?.token
    ? { resolution: { token: String(body.resolution.token), approved: body.resolution.approved === true } }
    : { messages: Array.isArray(body.messages) ? body.messages : [] };

  const clientTools = parseClientTools(body.clientTools);
  const events = runAgent(start, {
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    system: buildSystemBlocks(await recallMemoryForPrompt(), new Date(), {
      recentConversations: await recentEpisodesForPrompt(),
      speaking: describeSignals(parseSignals(body.signals)),
      ...(body.client === "android" ? { channel: PHONE_CHANNEL_NOTE } : {}),
    }),
    clientTools,
    // Fires when the browser aborts the fetch (the user said "stop"), so we
    // stop paying for tokens nobody will hear.
    signal: req.signal,
    advisor: settings.advisor,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", error })}\n`));
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
