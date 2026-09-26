import type Anthropic from "@anthropic-ai/sdk";

// The client resends the whole conversation every turn. Without a cap it
// grows until it overflows the context window (and costs more each turn).
const MAX_HISTORY_MESSAGES = 40;

/**
 * Every assistant tool_use must be answered by a tool_result in the next
 * user message, or the API rejects the whole request. That breaks when a
 * confirmation expires or is abandoned: the client's history ends in a
 * tool_use that never got a result, and every later message would fail
 * until the page is reloaded. Fill in the missing results as "not run".
 */
export function repairToolPairs(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    const toolIds = msg.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.ToolUseBlockParam).id);
    if (toolIds.length === 0) continue;

    const next = messages[i + 1];
    const nextBlocks: Anthropic.ContentBlockParam[] =
      next?.role === "user" ? (typeof next.content === "string" ? [{ type: "text", text: next.content }] : next.content) : [];
    const answered = new Set(
      nextBlocks.filter((b) => b.type === "tool_result").map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id),
    );
    const missing = toolIds.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;

    const filler: Anthropic.ToolResultBlockParam[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "Not run — the confirmation expired or was never answered.",
      is_error: true,
    }));
    const results = nextBlocks.filter((b) => b.type === "tool_result");
    const rest = nextBlocks.filter((b) => b.type !== "tool_result");
    out.push({ role: "user", content: [...results, ...filler, ...rest] });
    if (next?.role === "user") i++; // merged into the message just pushed
  }
  return out;
}

/** Keeps the most recent messages, cutting only where a fresh user turn
 *  starts (a plain message, not a tool_result) so no tool pair is split. */
export function trimHistory(messages: Anthropic.MessageParam[], max = MAX_HISTORY_MESSAGES): Anthropic.MessageParam[] {
  if (messages.length <= max) return messages;
  for (let start = messages.length - max; start < messages.length; start++) {
    const m = messages[start];
    const isFreshUserTurn =
      m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));
    if (isFreshUserTurn) return messages.slice(start);
  }
  return messages.slice(-1);
}

/** Replaces image blocks inside tool results with a short note. Used on the
 *  history sent back to the browser, which resends it every turn. */
export function stripImages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result" || !Array.isArray(b.content) || !b.content.some((c) => c.type === "image" || c.type === "document")) return b;
      changed = true;
      return {
        ...b,
        content: b.content.map((c) =>
          c.type === "image"
            ? { type: "text" as const, text: "[screenshot no longer attached]" }
            : c.type === "document"
              ? { type: "text" as const, text: "[document no longer attached — read it again if needed]" }
              : c,
        ),
      };
    });
    return changed ? { ...m, content } : m;
  });
}
