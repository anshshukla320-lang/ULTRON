import Anthropic from "@anthropic-ai/sdk";
import { AUTO_EXECUTE, TOOLS, executeTool, type ToolName } from "./tools";
import { recallMemoryForPrompt } from "./memory";

const MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 3;

const PHONE_SYSTEM_PROMPT_BASE = `You are U.L.T.R.O.N., talking to the user right now over a live phone call.
Keep every reply to 1-2 short sentences — no markdown, no lists, no emoji. This is read aloud by phone text-to-speech and the user is listening live, not reading. Address the user as "sir" naturally, not in every sentence. A little dry wit is fine when it genuinely fits, but keep it brief — this is a phone call, not a chat.
You can use read-only tools directly (system info, web search, listing/reading files or email). If the user asks for something that needs confirmation in the app first (installing software, writing a file, sending email, placing another call), tell them to do it from the Ultron app instead — you cannot get their confirmation over the phone.
You have long-term memory via the remember/forget tools, shared with the app — anything worth carrying into future conversations (a lasting preference or fact), save it concisely. Don't remember one-off results or time-sensitive things.
If the user sounds done (says bye, thanks, nothing else, that's all), give a brief goodbye and don't ask another question.`;

function buildPhoneSystemPrompt(memoryNotes: string): string {
  const base = `${PHONE_SYSTEM_PROMPT_BASE}\nCurrent local date and time: ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}.`;
  if (!memoryNotes) return base;
  return `${base}\n\nThings you've learned and remembered from earlier conversations (use naturally where relevant — don't recite this list):\n${memoryNotes}`;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

export async function runPhoneTurn(
  priorMessages: Anthropic.MessageParam[],
  userUtterance: string,
): Promise<{ reply: string; messages: Anthropic.MessageParam[] }> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const working: Anthropic.MessageParam[] = [...priorMessages, { role: "user", content: userUtterance }];
  const systemPrompt = buildPhoneSystemPrompt(await recallMemoryForPrompt());

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: systemPrompt,
      tools: TOOLS,
      messages: working,
    });
    working.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return { reply: extractText(response.content) || "Okay.", messages: working };
    }

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of toolUseBlocks) {
      if (!AUTO_EXECUTE.has(b.name as ToolName)) {
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: "That needs confirming in the Ultron app — I can't do it over the phone.",
          is_error: true,
        });
        continue;
      }
      try {
        const output = await executeTool(b.name as ToolName, b.input as Record<string, unknown>);
        // No screen on a phone call — send only the text part of image results.
        results.push({ type: "tool_result", tool_use_id: b.id, content: typeof output === "string" ? output : output.text });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: err instanceof Error ? err.message : String(err), is_error: true });
      }
    }
    working.push({ role: "user", content: results });
  }

  return { reply: "That took too many steps to answer on a call — try asking more simply.", messages: working };
}
