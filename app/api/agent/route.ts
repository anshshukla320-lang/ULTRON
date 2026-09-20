import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { AUTO_EXECUTE, TOOLS, executeTool, type ToolName } from "@/lib/agent/tools";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 6;

const SYSTEM_PROMPT = `You are U.L.T.R.O.N., a voice-controlled assistant running locally on the user's own Windows PC.
Speak like a sharp, understated AI (Jarvis-esque): brief, confident, no filler, no markdown, no emoji, no bullet lists — your replies are read aloud by text-to-speech.
You can launch installed apps, open URLs, read/write files inside your sandboxed workspace folder, search the web, and install new applications via tools. Use a tool whenever the user's request calls for one; don't ask permission yourself, the system already gates risky actions with a confirmation prompt.
When the user asks to install an app, call search_app first to find the exact winget package id (prefer the publisher-verified "winget" source over "msstore" when both list the same app, and pick the closest name match), then call install_app with that id — never invent a package id.
You can also read and send the user's Gmail. If a Gmail tool errors saying it isn't connected, tell the user to visit /api/gmail/auth in their browser to connect it. Always show the user the drafted subject/body before send_email runs (the confirmation prompt will display it) — never guess a recipient's address if the user didn't give one.
If the user asks you to call them, check in on their machine, or report any issues over the phone, use call_health_report — it places a real phone call that reads out disk/memory/CPU/system-error status plus important unread emails.
For anything you'd need current information to answer (news, facts, prices, "what is", "who is", etc.), use web_search and answer from the results yourself — don't just guess from memory. Use open_search when the user wants to browse results themselves (e.g. "search for cat videos on youtube", "look up X on google").
When the user asks to play a song, artist, or music, prefer spotify_play — it actually starts playback on their Spotify app instead of just opening a page. Only fall back to play_video (opens YouTube in the browser with autoplay) if spotify_play errors (not connected, no Premium, etc.) — mention why you fell back. Use spotify_pause/spotify_next/spotify_previous for playback control once something's playing.
For anything that isn't music — a trailer, a tutorial, highlights, "open and play the video about X" — use play_video directly; it finds the specific YouTube video and opens it with autoplay, no need to search first.
After a tool result comes back, briefly tell the user what happened in one short sentence. If a tool errors, say so plainly and suggest a fix.
If a request is ambiguous, make a reasonable assumption and say what you assumed rather than stopping to ask.`;

interface ToolUseRef {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

interface ReadyResult {
  id: string;
  output: string;
  isError?: boolean;
}

interface ActionLogEntry {
  name: string;
  input: unknown;
  output?: string;
  status: "done" | "declined" | "error";
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function toolResultBlock(r: ReadyResult): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: r.id,
    content: r.output,
    ...(r.isError ? { is_error: true } : {}),
  };
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart the dev server." },
      { status: 500 },
    );
  }

  const body = await req.json();
  const messages: Anthropic.MessageParam[] = Array.isArray(body?.messages) ? body.messages : [];
  const resolution: {
    toolUse: ToolUseRef[];
    readyResults: ReadyResult[];
    approved: boolean;
  } | null = body?.resolution ?? null;

  if (messages.length === 0) {
    return NextResponse.json({ error: "messages must be a non-empty array." }, { status: 400 });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const working: Anthropic.MessageParam[] = [...messages];
  const actionsLog: ActionLogEntry[] = [];

  try {
    if (resolution) {
      const blocks: Anthropic.ToolResultBlockParam[] = resolution.readyResults.map(toolResultBlock);

      for (const tu of resolution.toolUse) {
        if (!resolution.approved) {
          blocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "The user declined to run this action.",
            is_error: true,
          });
          actionsLog.push({ name: tu.name, input: tu.input, status: "declined" });
          continue;
        }
        try {
          const output = await executeTool(tu.name, tu.input);
          blocks.push({ type: "tool_result", tool_use_id: tu.id, content: output });
          actionsLog.push({ name: tu.name, input: tu.input, output, status: "done" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          blocks.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
          actionsLog.push({ name: tu.name, input: tu.input, output: msg, status: "error" });
        }
      }

      working.push({ role: "user", content: blocks });
    }

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: working,
      });

      working.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        return NextResponse.json({
          messages: working,
          reply: extractText(response.content),
          actions: actionsLog,
          pending: null,
        });
      }

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const autoBlocks = toolUseBlocks.filter((b) => AUTO_EXECUTE.has(b.name as ToolName));
      const confirmBlocks = toolUseBlocks.filter((b) => !AUTO_EXECUTE.has(b.name as ToolName));

      const readyResults: ReadyResult[] = [];
      for (const b of autoBlocks) {
        try {
          const output = await executeTool(b.name as ToolName, b.input as Record<string, unknown>);
          readyResults.push({ id: b.id, output });
          actionsLog.push({ name: b.name, input: b.input, output, status: "done" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          readyResults.push({ id: b.id, output: msg, isError: true });
          actionsLog.push({ name: b.name, input: b.input, output: msg, status: "error" });
        }
      }

      if (confirmBlocks.length > 0) {
        return NextResponse.json({
          messages: working,
          reply: extractText(response.content),
          actions: actionsLog,
          pending: {
            toolUse: confirmBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
            readyResults,
          },
        });
      }

      working.push({ role: "user", content: readyResults.map(toolResultBlock) });
    }

    return NextResponse.json(
      { error: "Agent exceeded the maximum number of tool steps for one command." },
      { status: 500 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
