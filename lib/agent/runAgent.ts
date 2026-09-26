import type Anthropic from "@anthropic-ai/sdk";
import { TOOLS, confirmationInput, executeTool, needsConfirmation, type ToolName, type ToolOutput } from "./tools";
import { stashPendingAction, takePendingAction, type PendingToolUse } from "./pendingActions";
import { repairToolPairs, stripImages, trimHistory } from "./conversationHistory";
import { recordUsage, type Feature } from "./usage";

// Sonnet answers everything, because for a voice assistant time-to-first-
// word matters. For genuinely hard questions it consults Opus 5 through the
// advisor tool (server-side: one request, Opus plans, Sonnet speaks), so
// quick commands stay fast and only hard questions pay for the bigger model.
export const MODEL = "claude-sonnet-5";
export const ADVISOR_MODEL = "claude-opus-5";
const ADVISOR_BETA = "advisor-tool-2026-03-01";
const ADVISOR_TOOL: Anthropic.Beta.Messages.BetaAdvisorTool20260301 = {
  type: "advisor_20260301",
  name: "advisor",
  model: ADVISOR_MODEL,
  max_uses: 2,
  max_tokens: 8000,
  caching: { type: "ephemeral", ttl: "5m" },
};

// Set when the API rejects the advisor (e.g. the beta isn't enabled for this
// API key) so every later request goes straight to plain Sonnet.
let advisorUnavailable = false;
function advisorWanted(): boolean {
  return process.env.ULTRON_ADVISOR !== "off" && !advisorUnavailable;
}
/** Test hook. */
export function resetAdvisorState(): void {
  advisorUnavailable = false;
}

// Once the history holds advisor results the tool must stay in the request,
// or the API rejects the whole conversation.
function historyUsesAdvisor(messages: Anthropic.MessageParam[]): boolean {
  return messages.some(
    (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => (b.type as string) === "advisor_tool_result"),
  );
}
const MAX_ITERATIONS = 6;
// Long enough for write_file drafts (meal plans, marketing copy).
const MAX_TOKENS = 4096;
const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.name));

// The last tool definition carries a cache breakpoint too, so the tool list
// (the biggest fixed part of every request) is cached even if the system
// prompt text is edited. Tool order is fixed, so the prefix is stable.
const CACHED_TOOLS: Anthropic.Tool[] = TOOLS.map((t, i) =>
  i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
);

export interface ActionLogEntry {
  name: string;
  input: unknown;
  output?: string;
  status: "done" | "declined" | "error";
}

export type AgentEvent =
  /** A chunk of the spoken reply, as it streams in. */
  | { type: "text"; text: string }
  /** A tool ran (or was declined / failed). */
  | { type: "action"; action: ActionLogEntry }
  /** Final state: full history for the client to keep, plus a pending
   *  confirmation if the turn is waiting on the user. */
  | {
      type: "done";
      messages: Anthropic.MessageParam[];
      reply: string;
      pending: { token: string; toolUse: PendingToolUse[] } | null;
      /** Tools the client (the phone app) must run itself. The client sends
       *  the conversation back with one user message holding `serverResults`
       *  followed by its own tool_result blocks for these calls. */
      clientCalls?: PendingToolUse[];
      serverResults?: Anthropic.ToolResultBlockParam[];
    }
  | { type: "error"; error: string };

export type AgentStart =
  | { messages: Anthropic.MessageParam[] }
  | { resolution: { token: string; approved: boolean } };

export interface AgentDeps {
  client: Pick<Anthropic, "beta">;
  system: Anthropic.TextBlockParam[];
  /** Overridable for tests. */
  execute?: (name: ToolName, input: Record<string, unknown>, ctx?: { signal?: AbortSignal; confirmed?: boolean }) => Promise<ToolOutput>;
  signal?: AbortSignal;
  /** From the control panel; false never offers the advisor. */
  advisor?: boolean;
  /** Which usage bucket this conversation's cost is counted under. */
  feature?: Feature;
  /** Tools that run on the client (the phone app: calls, SMS, alarms…).
   *  Claude can call them; the turn then pauses and hands them back. */
  clientTools?: Anthropic.Tool[];
}

interface ReadyResult {
  id: string;
  output: ToolOutput;
  isError?: boolean;
}

function outputText(output: ToolOutput): string {
  return typeof output === "string" ? output : output.text;
}

function toolResultBlock(r: ReadyResult): Anthropic.ToolResultBlockParam {
  const o = r.output;
  const content: Anthropic.ToolResultBlockParam["content"] =
    typeof o === "string"
      ? o
      : "image" in o
        ? [
            { type: "image", source: { type: "base64", media_type: o.image.mediaType, data: o.image.data } },
            { type: "text", text: o.text },
          ]
        : [
            { type: "document", source: { type: "base64", media_type: o.document.mediaType, data: o.document.data } },
            { type: "text", text: o.text },
          ];
  return { type: "tool_result", tool_use_id: r.id, content, ...(r.isError ? { is_error: true } : {}) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The agent loop: stream Claude's reply, run tools, repeat until Claude is
 * done or a tool needs the user's confirmation. Yields events as they
 * happen so the client can start speaking the first sentence while the rest
 * is still being written.
 */
export async function* runAgent(start: AgentStart, deps: AgentDeps): AsyncGenerator<AgentEvent> {
  const execute = deps.execute ?? executeTool;
  let working: Anthropic.MessageParam[];
  let spoken = "";

  if ("resolution" in start) {
    // The client only ever sends back a token + approved/declined — never
    // the tool name/input themselves, so it can't get anything executed
    // beyond exactly what the server proposed and stashed earlier.
    const stashed = takePendingAction(start.resolution.token);
    if (!stashed) {
      yield { type: "error", error: "That confirmation has expired or was already used — ask again." };
      return;
    }
    working = [...stashed.messages];
    const blocks: Anthropic.ToolResultBlockParam[] = stashed.readyResults.map(toolResultBlock);
    for (const tu of stashed.toolUse) {
      if (!start.resolution.approved) {
        blocks.push({ type: "tool_result", tool_use_id: tu.id, content: "The user declined to run this action.", is_error: true });
        yield { type: "action", action: { name: tu.name, input: tu.input, status: "declined" } };
        continue;
      }
      try {
        const output = await execute(tu.name as ToolName, tu.input, { signal: deps.signal, confirmed: true });
        blocks.push(toolResultBlock({ id: tu.id, output }));
        yield { type: "action", action: { name: tu.name, input: tu.input, output: outputText(output), status: "done" } };
      } catch (err) {
        const msg = errorMessage(err);
        blocks.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
        yield { type: "action", action: { name: tu.name, input: tu.input, output: msg, status: "error" } };
      }
    }
    working.push({ role: "user", content: blocks });
  } else {
    if (!Array.isArray(start.messages) || start.messages.length === 0) {
      yield { type: "error", error: "messages must be a non-empty array." };
      return;
    }
    working = trimHistory(repairToolPairs(start.messages));
  }

  // Screenshots are only useful for the turn they were taken in; resending
  // megabytes of base64 every later turn would cost tokens for nothing.
  const finish = (pending: { token: string; toolUse: PendingToolUse[] } | null): AgentEvent => ({
    type: "done",
    messages: stripImages(working),
    reply: spoken.trim(),
    pending,
  });
  const clientTools = deps.clientTools ?? [];
  const clientToolNames = new Set(clientTools.map((t) => t.name));

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response: Anthropic.Beta.Messages.BetaMessage;
    const useAdvisor = (deps.advisor !== false && advisorWanted()) || historyUsesAdvisor(working);
    try {
      const stream = deps.client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: deps.system,
          // Client tools go after the cached server tools, so the phone's
          // list doesn't disturb the cached prefix.
          tools: [...CACHED_TOOLS, ...clientTools, ...(useAdvisor ? [ADVISOR_TOOL] : [])],
          // Caches the conversation so far, so each step of a multi-tool
          // turn only pays full price for what's new.
          cache_control: { type: "ephemeral" },
          messages: working as Anthropic.Beta.Messages.BetaMessageParam[],
          ...(useAdvisor ? { betas: [ADVISOR_BETA] } : {}),
        },
        { signal: deps.signal },
      );
      // Separate turns within one reply ("Opening Notepad." ... "Done.")
      // need a space between them when they're joined.
      let first = true;
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          let text = event.delta.text;
          if (first && spoken && !/\s$/.test(spoken)) text = ` ${text}`;
          first = false;
          spoken += text;
          yield { type: "text", text };
        }
      }
      response = await stream.finalMessage();
      void recordUsage(deps.feature ?? "chat", response.model ?? MODEL, response.usage);
    } catch (err) {
      if (deps.signal?.aborted) return; // the user said "stop" — nothing to report
      const status = (err as { status?: number }).status;
      if (useAdvisor && status === 400 && /advisor/i.test(errorMessage(err)) && !historyUsesAdvisor(working)) {
        advisorUnavailable = true; // retry this step without it
        i--;
        continue;
      }
      yield { type: "error", error: errorMessage(err) };
      return;
    }

    if (response.content.some((b) => b.type === "advisor_tool_result")) {
      yield { type: "action", action: { name: "deep_thinking", input: {}, output: `Consulted ${ADVISOR_MODEL}.`, status: "done" } };
    }

    working.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

    // A long server-side step (the advisor) can pause the turn; sending the
    // conversation back as-is lets it carry on where it stopped.
    if (response.stop_reason === "pause_turn") continue;

    if (response.stop_reason === "refusal") {
      if (!spoken.trim()) {
        const text = "I can't help with that one, sir.";
        spoken = text;
        yield { type: "text", text };
      }
      yield finish(null);
      return;
    }

    const toolUseBlocks = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      // A tool call cut off at max_tokens is incomplete — never run it. The
      // next request's history repair answers it as "not run".
      yield finish(null);
      return;
    }

    // A tool name the model made up must not reach the confirm modal —
    // the user would be asked to approve something that can't run.
    const readyResults: ReadyResult[] = [];
    const confirmBlocks: Anthropic.Beta.Messages.BetaToolUseBlock[] = [];
    const clientBlocks = toolUseBlocks.filter((b) => clientToolNames.has(b.name));
    for (const b of toolUseBlocks) {
      const input = b.input as Record<string, unknown>;
      if (clientToolNames.has(b.name)) continue; // the phone runs these
      if (!KNOWN_TOOLS.has(b.name)) {
        const msg = `There is no tool named "${b.name}".`;
        readyResults.push({ id: b.id, output: msg, isError: true });
        yield { type: "action", action: { name: b.name, input, output: msg, status: "error" } };
      } else if (needsConfirmation(b.name, input)) {
        if (clientBlocks.length) {
          // A confirm box and a hand-off to the phone can't share one turn.
          const msg = "Not run: this needs the user's confirmation — ask for it on its own, after the phone actions.";
          readyResults.push({ id: b.id, output: msg, isError: true });
          continue;
        }
        confirmBlocks.push(b);
      } else {
        try {
          const output = await execute(b.name as ToolName, input, { signal: deps.signal });
          readyResults.push({ id: b.id, output });
          yield { type: "action", action: { name: b.name, input, output: outputText(output), status: "done" } };
        } catch (err) {
          const msg = errorMessage(err);
          readyResults.push({ id: b.id, output: msg, isError: true });
          yield { type: "action", action: { name: b.name, input, output: msg, status: "error" } };
        }
      }
      if (deps.signal?.aborted) return;
    }

    if (clientBlocks.length > 0) {
      const done = finish(null) as Extract<AgentEvent, { type: "done" }>;
      yield {
        ...done,
        clientCalls: clientBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
        serverResults: readyResults.map(toolResultBlock),
      };
      return;
    }

    if (confirmBlocks.length > 0) {
      const toolUse = confirmBlocks.map((b) => ({ id: b.id, name: b.name, input: confirmationInput(b.name, b.input as Record<string, unknown>) }));
      const token = stashPendingAction({ toolUse, readyResults, messages: working });
      // toolUse here is for the confirm modal to DISPLAY only — actually
      // executing it requires the token, which only the server can mint.
      yield finish({ token, toolUse });
      return;
    }

    working.push({ role: "user", content: readyResults.map(toolResultBlock) });
  }

  // Out of steps: still answer out loud, and keep the work done so far.
  const text = `${spoken ? " " : ""}That's taking more steps than I'm allowed for one command, sir. Tell me how you'd like me to continue.`;
  spoken += text;
  yield { type: "text", text };
  yield finish(null);
}
