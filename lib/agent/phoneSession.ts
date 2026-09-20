import type Anthropic from "@anthropic-ai/sdk";

export interface PhoneSession {
  messages: Anthropic.MessageParam[];
  turns: number;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
export const MAX_TURNS = 8;

const sessions = new Map<string, PhoneSession>();

function sweep() {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(sid);
  }
}

export function initPhoneSession(callSid: string, openingLine: string): void {
  sweep();
  sessions.set(callSid, {
    messages: [{ role: "assistant", content: openingLine }],
    turns: 0,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function getPhoneSession(callSid: string): PhoneSession | null {
  sweep();
  const session = sessions.get(callSid);
  if (session) session.expiresAt = Date.now() + TTL_MS;
  return session ?? null;
}

export function endPhoneSession(callSid: string): void {
  sessions.delete(callSid);
}
