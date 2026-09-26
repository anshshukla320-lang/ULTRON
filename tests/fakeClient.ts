import type Anthropic from "@anthropic-ai/sdk";
import type { AgentDeps } from "../lib/agent/runAgent";

// A scripted stand-in for the Anthropic client: each call to
// messages.stream() plays the next scripted response and records the request.
export type Scripted = {
  text?: string;
  tools?: [string, Record<string, unknown>][];
  stop?: string;
  advisor?: boolean; // include a server-side advisor consultation in the reply
  fail?: { status: number; message: string };
};

export function fakeClient(script: Scripted[]) {
  const requests: Record<string, unknown>[] = [];
  let n = 0;
  const client = {
    beta: { messages: {
      stream(body: Record<string, unknown>, opts?: { signal?: AbortSignal }) {
        requests.push(structuredClone(body));
        const step = script[Math.min(n++, script.length - 1)];
        if (step.fail) {
          const err = Object.assign(new Error(step.fail.message), { status: step.fail.status });
          return { async *[Symbol.asyncIterator]() { throw err; }, finalMessage: async () => { throw err; } };
        }
        const content: Record<string, unknown>[] = [];
        if (step.advisor) {
          content.push({ type: "server_tool_use", id: `srvtoolu_${n}`, name: "advisor", input: {} });
          content.push({ type: "advisor_tool_result", tool_use_id: `srvtoolu_${n}`, content: { type: "advisor_redacted_result", encrypted_content: "ENC", stop_reason: "end_turn" } });
        }
        if (step.text) content.push({ type: "text", text: step.text, citations: null });
        for (const [name, input] of step.tools ?? []) content.push({ type: "tool_use", id: `toolu_${n}_${name}`, name, input });
        const message = {
          id: `msg_${n}`,
          type: "message",
          role: "assistant",
          model: "fake",
          content,
          stop_reason: step.stop ?? (step.tools?.length ? "tool_use" : "end_turn"),
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
        const words = (step.text ?? "").split(/(?<= )/);
        return {
          async *[Symbol.asyncIterator]() {
            for (const w of words) {
              if (opts?.signal?.aborted) throw new Error("aborted");
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } };
            }
          },
          finalMessage: async () => message,
        };
      },
    } },
  };
  return { client: client as unknown as AgentDeps["client"], requests };
}

