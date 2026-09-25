import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolOutput } from "./tools";

export interface PendingToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface PendingReadyResult {
  id: string;
  output: ToolOutput;
  isError?: boolean;
}

interface StashedResolution {
  toolUse: PendingToolUse[];
  readyResults: PendingReadyResult[];
  messages: Anthropic.MessageParam[];
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, StashedResolution>();

function sweep() {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt < now) store.delete(token);
  }
}

/**
 * Confirm-required tools (install_app, write_file, send_email,
 * call_health_report) must only ever run with the exact name/input the
 * model actually proposed — never whatever a client resends. The server
 * stashes the real pending call here and hands back a random token; the
 * client's "Confirm" click can only ever trigger exactly this stashed
 * action, single-use, short-lived. Without this, anyone who can reach
 * /api/agent could send an arbitrary {name, input, approved: true} and get
 * it executed, skipping the confirmation entirely.
 */
export function stashPendingAction(data: Omit<StashedResolution, "expiresAt">): string {
  sweep();
  const token = crypto.randomBytes(24).toString("hex");
  store.set(token, { ...data, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function takePendingAction(token: string): StashedResolution | null {
  sweep();
  const entry = store.get(token);
  if (!entry) return null;
  store.delete(token); // single-use
  return entry;
}
