import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { runAgent, type AgentStart } from "./runAgent";
import { buildSystemBlocks } from "./systemPrompt";
import { recallMemoryForPrompt } from "./memory";
import { recentEpisodesForPrompt } from "./episodes";
import { getSettings } from "./settings";
import { stripSpeechMarkup } from "../speechSegments";

// Talk to ULTRON from your phone through a Telegram bot. Create a bot with
// @BotFather, put its token in TELEGRAM_BOT_TOKEN, message it once — it
// replies with your chat id — and put that in TELEGRAM_ALLOWED_CHAT_IDS.
// Anyone else who finds the bot gets nothing.

const API = "https://api.telegram.org";
const MAX_HISTORY = 30;

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

export function allowedChats(): string[] {
  return (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function tg<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

/** Sends text to one chat, split at Telegram's 4096-character limit. */
export async function sendTelegram(chatId: string, text: string): Promise<void> {
  if (!token()) return;
  const clean = stripSpeechMarkup(text).trim() || "…";
  for (let i = 0; i < clean.length; i += 4000) {
    await tg("sendMessage", { chat_id: chatId, text: clean.slice(i, i + 4000) });
  }
}

/** Background notifications to the owner's phone (when enabled). */
export async function notifyTelegram(text: string): Promise<void> {
  if (!token()) return;
  const settings = await getSettings();
  if (!settings.telegramNotifications) return;
  for (const chat of allowedChats()) await sendTelegram(chat, text).catch(() => {});
}

interface ChatState {
  messages: MessageParam[];
  pendingToken: string | null;
}
const chats = new Map<string, ChatState>();

const YES = /^(yes|y|yeah|yep|confirm|ok|okay|go ahead|do it)[.!]*$/i;
const NO = /^(no|n|nope|cancel|stop|don'?t)[.!]*$/i;

export interface TelegramDeps {
  run: (start: AgentStart) => AsyncGenerator<import("./runAgent").AgentEvent>;
  send: (chatId: string, text: string) => Promise<void>;
}

async function defaultRun(start: AgentStart) {
  const settings = await getSettings();
  return runAgent(start, {
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    system: buildSystemBlocks(await recallMemoryForPrompt(), new Date(), {
      recentConversations: await recentEpisodesForPrompt(),
      channel:
        "The user is texting you on Telegram from their phone, not speaking. Your reply is read, not heard: plain text (no markdown), and it can be a little more detailed than a spoken answer. Anything shown on the PC screen or played on its speakers happens at home, where the user may not be.",
    }),
    advisor: settings.advisor,
    feature: "telegram",
  });
}

/** Handles one incoming message. Exported for tests. */
export async function handleTelegramMessage(chatId: string, text: string, deps: TelegramDeps): Promise<void> {
  if (!allowedChats().includes(chatId)) {
    await deps.send(
      chatId,
      `I only talk to my owner. If that's you, add TELEGRAM_ALLOWED_CHAT_IDS=${chatId} to ULTRON's .env.local and restart it.`,
    );
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed === "/start") {
    await deps.send(chatId, "ULTRON here, sir. Ask me anything you'd ask at the PC.");
    return;
  }
  const state = chats.get(chatId) ?? { messages: [], pendingToken: null };
  chats.set(chatId, state);

  let start: AgentStart;
  if (state.pendingToken && (YES.test(trimmed) || NO.test(trimmed))) {
    start = { resolution: { token: state.pendingToken, approved: YES.test(trimmed) } };
  } else {
    start = { messages: [...state.messages, { role: "user", content: trimmed }] };
  }
  state.pendingToken = null;

  let reply = "";
  for await (const e of await deps.run(start)) {
    if (e.type === "error") {
      await deps.send(chatId, `That didn't work: ${e.error}`);
      return;
    }
    if (e.type === "done") {
      state.messages = e.messages.slice(-MAX_HISTORY);
      reply = e.reply;
      if (e.pending) {
        state.pendingToken = e.pending.token;
        const what = e.pending.toolUse.map((t) => `• ${t.name.replace(/_/g, " ")} ${JSON.stringify(t.input)}`).join("\n");
        reply = `${reply ? `${reply}\n\n` : ""}This needs your OK:\n${what}\n\nReply YES to go ahead or NO to cancel.`;
      }
    }
  }
  await deps.send(chatId, reply || "Done, sir.");
}

/** Long-polls Telegram for messages. Started from instrumentation.ts. */
export function startTelegramBot(): void {
  if (!token()) return;
  const g = globalThis as { __ultronTelegram?: boolean };
  if (g.__ultronTelegram) return;
  g.__ultronTelegram = true;
  const deps: TelegramDeps = { run: (s) => defaultRunIterable(s), send: sendTelegram };
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const updates = await tg<{ update_id: number; message?: { chat: { id: number }; text?: string } }[]>(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message"] },
          AbortSignal.timeout(40_000),
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message?.text) {
            await handleTelegramMessage(String(u.message.chat.id), u.message.text, deps).catch((err) =>
              console.error("ULTRON Telegram message failed:", err),
            );
          }
        }
      } catch (err) {
        console.error("ULTRON Telegram polling error:", err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  void loop();
  console.log("ULTRON Telegram bot running.");
}

async function* defaultRunIterable(start: AgentStart) {
  yield* await defaultRun(start);
}
