import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "./usage";

/** One structured-output call: Claude answers with JSON matching `schema`. */
export async function claudeJson<T>(opts: {
  model: string;
  system: string;
  content: string;
  schema: Record<string, unknown>;
  usage: Parameters<typeof recordUsage>[0];
  maxTokens?: number;
}): Promise<T> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
    output_config: { format: { type: "json_schema", schema: opts.schema } },
  });
  void recordUsage(opts.usage, opts.model, response.usage);
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
  return JSON.parse(text) as T;
}

/** Emails wrapped for a prompt, each clipped. */
export function emailsForPrompt(emails: { id: string; text: string }[], clip = 3000): string {
  return emails.map((e) => `<email id="${e.id}">\n${e.text.slice(0, clip)}\n</email>`).join("\n\n");
}
