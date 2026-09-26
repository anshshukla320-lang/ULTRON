import Anthropic from "@anthropic-ai/sdk";
import { takeDue, type DueItem } from "./reminders";
import { checkProactive } from "./proactive";
import { pageIsOpen } from "./presence";
import { getSettings } from "./settings";
import { showNotification, speakOnPc } from "./nativeOutput";
import { notifyTelegram } from "./telegram";
import { runAgent } from "./runAgent";
import { buildSystemBlocks } from "./systemPrompt";
import { recallMemoryForPrompt } from "./memory";

// Background mode: when no ULTRON page is open, the server itself announces
// timers, reminders, proactive notices and the daily briefing — as a Windows
// notification and out loud through the PC's speakers.

const TICK_MS = 10_000;

export interface BackgroundDeps {
  pageIsOpen: () => Promise<boolean>;
  takeDue: () => Promise<DueItem[]>;
  checkProactive: () => Promise<DueItem[]>;
  notify: (title: string, body: string) => Promise<void>;
  speak: (text: string) => Promise<void>;
  phone: (text: string) => Promise<void>;
  briefing: () => Promise<string>;
  settings: () => Promise<{ backgroundSpeech: boolean; backgroundNotifications: boolean }>;
}

/** Spoken/written line for one due item (same wording as the page uses). */
export function lineFor(item: DueItem): string {
  if (item.kind === "timer") return `Sir, your ${item.text} timer is done.`;
  if (item.kind === "reminder") return `Sir, a reminder: ${item.text}.`;
  return item.text;
}

async function runBriefing(): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "Good morning, sir. I couldn't prepare the briefing — the Claude API key isn't set.";
  let reply = "";
  for await (const e of runAgent(
    { messages: [{ role: "user", content: "Give me my morning briefing." }] },
    {
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
      system: buildSystemBlocks(await recallMemoryForPrompt()),
      feature: "background",
    },
  )) {
    if (e.type === "done") reply = e.reply; // a briefing never needs a confirmation
  }
  return reply || "Good morning, sir.";
}

export const defaultBackgroundDeps: BackgroundDeps = {
  pageIsOpen: () => pageIsOpen(),
  takeDue: () => takeDue(),
  checkProactive: () => checkProactive(),
  notify: showNotification,
  speak: speakOnPc,
  phone: notifyTelegram,
  briefing: runBriefing,
  settings: getSettings,
};

/** One pass: deliver anything due, unless a page is open to do it. */
export async function backgroundTick(deps: BackgroundDeps = defaultBackgroundDeps): Promise<DueItem[]> {
  if (await deps.pageIsOpen()) return [];
  const due = [...(await deps.takeDue()), ...(await deps.checkProactive().catch(() => []))];
  if (due.length === 0) return [];
  const settings = await deps.settings();
  for (const item of due) {
    const text = item.kind === "briefing" ? await deps.briefing() : lineFor(item);
    const title = item.kind === "briefing" ? "Morning briefing" : item.kind === "notice" ? "ULTRON" : item.kind === "timer" ? "Timer done" : "Reminder";
    if (settings.backgroundNotifications) await deps.notify(title, text).catch((e) => console.error("ULTRON notification failed:", e));
    // Nobody at the PC may hear it — the phone gets it too, if set up.
    await deps.phone(text).catch(() => {});
    if (settings.backgroundSpeech) await deps.speak(text).catch((e) => console.error("ULTRON background speech failed:", e));
  }
  return due;
}

/** Started once per server process from instrumentation.ts. */
export function startBackgroundLoop(): void {
  const g = globalThis as { __ultronBackground?: boolean };
  if (g.__ultronBackground) return; // dev-mode reloads
  g.__ultronBackground = true;
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    backgroundTick()
      .catch((err) => console.error("ULTRON background tick failed:", err))
      .finally(() => {
        running = false;
      });
  }, TICK_MS).unref();
  console.log("ULTRON background mode running (announces reminders when no page is open).");
}
