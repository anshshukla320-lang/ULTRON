import type Anthropic from "@anthropic-ai/sdk";

// Tools a client app brings with it — the phone app lends ULTRON its own
// abilities (calls, SMS, alarms, torch…). They run on the phone, never here;
// the server only relays the call. Names must start with "phone_" so they
// can never shadow a PC tool.

const NAME = /^phone_[a-z0-9_]{2,40}$/;
const MAX_TOOLS = 40;
const MAX_JSON = 6000; // per tool definition

export function parseClientTools(raw: unknown): Anthropic.Tool[] {
  if (!Array.isArray(raw)) return [];
  const tools: Anthropic.Tool[] = [];
  const seen = new Set<string>();
  for (const t of raw.slice(0, MAX_TOOLS)) {
    if (!t || typeof t !== "object") continue;
    const { name, description, input_schema } = t as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name) || seen.has(name)) continue;
    if (typeof description !== "string" || description.length > 1500) continue;
    if (!input_schema || typeof input_schema !== "object" || (input_schema as { type?: unknown }).type !== "object") continue;
    if (JSON.stringify(t).length > MAX_JSON) continue;
    seen.add(name);
    tools.push({ name, description, input_schema: input_schema as Anthropic.Tool.InputSchema });
  }
  return tools;
}

export const PHONE_CHANNEL_NOTE =
  "The user is talking to you from the ULTRON app on their Android phone, possibly away from the PC. Tools starting with phone_ act on the phone itself (calls, texts, alarms, torch, location, its apps and volume) — use them for anything about the phone, and prefer them for calls, texts and WhatsApp (phone_whatsapp, not send_whatsapp, which uses the PC). The other tools act on the PC and home as usual. Replies are spoken by the phone.";
