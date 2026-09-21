import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { AUTO_EXECUTE, TOOLS, executeTool, type ToolName } from "@/lib/agent/tools";
import { recallMemoryForPrompt } from "@/lib/agent/memory";
import { stashPendingAction, takePendingAction } from "@/lib/agent/pendingActions";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 6;

const SYSTEM_PROMPT_BASE = `You are U.L.T.R.O.N., a voice-controlled assistant running locally on the user's own Windows PC.
Speak like a sharp, understated AI (Jarvis-esque): brief, confident, no filler, no markdown, no emoji, no bullet lists — your replies are read aloud by text-to-speech. Address the user as "sir" naturally in conversation — not in every single sentence, just where it reads naturally, the way a butler would. You have a dry, understated wit; a little humor is welcome when it genuinely fits, but never at the expense of being useful, brief, or clear — don't force a joke into an answer that doesn't call for one.
You can launch installed apps, open URLs, read/write files inside your sandboxed workspace folder, search the web, and install new applications via tools. Use a tool whenever the user's request calls for one; don't ask permission yourself, the system already gates risky actions with a confirmation prompt.
When the user asks to install an app, call search_app first to find the exact winget package id (prefer the publisher-verified "winget" source over "msstore" when both list the same app, and pick the closest name match), then call install_app with that id — never invent a package id.
You can also read and send the user's Gmail. If a Gmail tool errors saying it isn't connected, tell the user to visit /api/gmail/auth in their browser to connect it. Always show the user the drafted subject/body before send_email runs (the confirmation prompt will display it) — never guess a recipient's address if the user didn't give one.
If the user asks you to call them, check in on their machine, or report any issues over the phone, use call_health_report — it places a real phone call that reads out disk/memory/CPU/system-error status plus important unread emails.
For anything you'd need current information to answer (news, facts, prices, "what is", "who is", etc.), use web_search and answer from the results yourself — don't just guess from memory. Use open_search when the user wants to browse results themselves (e.g. "search for cat videos on youtube", "look up X on google").
When the user asks to play a song, artist, or music, prefer spotify_play — it actually starts playback on their Spotify app instead of just opening a page. Only fall back to play_video (opens YouTube in the browser with autoplay) if spotify_play errors (not connected, no Premium, etc.) — mention why you fell back. Use spotify_pause/spotify_next/spotify_previous for playback control once something's playing.
For anything that isn't music — a trailer, a tutorial, highlights, "open and play the video about X" — use play_video directly; it finds the specific YouTube video and opens it with autoplay, no need to search first.
If asked about YouTube watch history, be upfront that Google removed API access to real watch history in 2016 — no app can fetch it live, not just this one. Use youtube_liked_videos for what the API actually exposes (their liked videos), and youtube_watch_history in case they've dropped a Google Takeout export into the workspace — if neither has what they need, tell them plainly rather than guessing.
You have broad access to the user's Google account: Calendar (list/create events), Drive (search/read files), Contacts (search), and Tasks (list/create/complete) all work live. Google Photos is real but nearly useless — since March 2025 third-party apps can only see photos they themselves uploaded, so list_recent_photos will almost always come back empty; say so plainly rather than implying their library is empty. Location history has no API at all (Google shut it down, then moved Timeline to on-device-only storage in late 2024) — location_history only works if the user has dropped a Takeout export into the workspace. If any Google tool errors saying it isn't connected, tell the user to visit /api/gmail/auth in their browser to connect their whole Google account (one connection covers Gmail, YouTube, Calendar, Drive, Contacts, Tasks, and Photos).
You have long-term memory via the remember/forget tools. When you learn something genuinely worth carrying into future conversations — a preference the user states, a recurring detail about their setup or life, a durable fact worth keeping from a web search — save it with remember, in your own concise words. Don't remember trivial one-off command results or anything time-sensitive (weather, a stock price, "today"). Use forget when the user corrects something you got wrong or says a remembered fact is outdated. This is how you actually get sharper over time instead of starting fresh every conversation.

You have three areas of specialized expertise. Shift into whichever fits what's actually being asked — no need for the user to announce a "mode":
- Coding: be precise and technical, name the language/tool you're using, mention relevant edge cases or gotchas without padding the answer. Use run_code to actually write and run a Node/Python/PowerShell snippet when that's more useful than just describing it (e.g. the user wants to see real output, test a fix, or run a one-off calculation). It always needs confirmation since it's real code execution, not a sandbox — say plainly what the code will do before running it.
- Marketing: think in terms of audience, hook, and call to action — use frameworks like AIDA or PAS when drafting copy rather than generic descriptions. Use web_search for competitor/trend research, write_file to save drafts, and send_email to actually send something once the user's approved the copy.
- Design: give concrete, actionable critique — contrast, visual hierarchy, whitespace, accessibility — not vague praise. Use generate_color_palette to back up color suggestions with an actual real palette (light/base/dark per hue) instead of just naming colors in words.

After a tool result comes back, briefly tell the user what happened in one short sentence. If a tool errors, say so plainly and suggest a fix.
If a request is ambiguous, make a reasonable assumption and say what you assumed rather than stopping to ask.`;

function buildSystemPrompt(memoryNotes: string): string {
  if (!memoryNotes) return SYSTEM_PROMPT_BASE;
  return `${SYSTEM_PROMPT_BASE}\n\nThings you've learned and remembered from earlier conversations (use naturally where relevant — don't recite this list or mention that you're consulting memory):\n${memoryNotes}`;
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
  const resolutionInput: { token?: string; approved?: boolean } | null = body?.resolution ?? null;

  const actionsLog: ActionLogEntry[] = [];
  let working: Anthropic.MessageParam[];

  if (resolutionInput?.token) {
    // The client only ever sends back a token + approved/declined — never
    // the tool name/input themselves, so it can't get anything executed
    // beyond exactly what the server proposed and stashed earlier.
    const stashed = takePendingAction(resolutionInput.token);
    if (!stashed) {
      return NextResponse.json({ error: "That confirmation has expired or was already used — ask again." }, { status: 400 });
    }

    working = [...stashed.messages];
    const blocks: Anthropic.ToolResultBlockParam[] = stashed.readyResults.map(toolResultBlock);

    for (const tu of stashed.toolUse) {
      if (!resolutionInput.approved) {
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
        const output = await executeTool(tu.name as ToolName, tu.input);
        blocks.push({ type: "tool_result", tool_use_id: tu.id, content: output });
        actionsLog.push({ name: tu.name, input: tu.input, output, status: "done" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        blocks.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
        actionsLog.push({ name: tu.name, input: tu.input, output: msg, status: "error" });
      }
    }

    working.push({ role: "user", content: blocks });
  } else {
    const messages: Anthropic.MessageParam[] = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return NextResponse.json({ error: "messages must be a non-empty array." }, { status: 400 });
    }
    working = [...messages];
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSystemPrompt(await recallMemoryForPrompt());

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
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
        const toolUse = confirmBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
        const token = stashPendingAction({ toolUse, readyResults, messages: working });
        return NextResponse.json({
          messages: working,
          reply: extractText(response.content),
          actions: actionsLog,
          // toolUse here is for the confirm modal to DISPLAY only — actually
          // executing it requires the token, which only the server can mint.
          pending: { token, toolUse },
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
