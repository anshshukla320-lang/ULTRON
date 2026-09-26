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
import { queueNotice } from "./reminders";
import { takeDueRoutines, runRoutineSteps } from "./routines";
import { executeTool, TOOL_POLICY, type ToolName } from "./tools";
import { geocode } from "./weather";
import { dailyBillScan, describeBill } from "./bills";
import { takeFocusDue, distractionNudge } from "./focus";
import { recordSample } from "./screenTime";
import { startDesktopHelper, type HelperHandle, type HelperLine } from "./desktopHelper";
import { emitPageEvent } from "./events";
import { runPowerShell } from "./powershell";

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
  /** Focus-mode round changes (optional so older callers/tests needn't care). */
  takeFocusDue?: () => Promise<DueItem[]>;
  /** Work that happens whether or not a page is open: scheduled routines, the daily bill scan. */
  housekeeping?: () => Promise<void>;
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

let coords: { key: string; value: { latitude: number; longitude: number } | null } | null = null;
async function homeCoords(): Promise<{ latitude: number; longitude: number } | null> {
  const place = process.env.ULTRON_HOME_LOCATION?.trim() ?? "";
  if (coords && coords.key === place) return coords.value;
  let value: { latitude: number; longitude: number } | null = null;
  if (place) {
    try {
      const g = await geocode(place);
      value = { latitude: g.latitude, longitude: g.longitude };
    } catch {
      return null; // offline — try again next time
    }
  }
  coords = { key: place, value };
  return value;
}

/** Scheduled routines. Only steps that run without confirmation are allowed
 *  in them (checked when saved, and again here). */
export async function runScheduledRoutines(now = new Date()): Promise<string[]> {
  const ran: string[] = [];
  for (const r of await takeDueRoutines(now, await homeCoords())) {
    const result = await runRoutineSteps(r, async (tool, input) => {
      if (!TOOL_POLICY.auto(tool)) throw new Error("needs confirmation — skipped in a scheduled run");
      return executeTool(tool as ToolName, input);
    });
    console.log(`ULTRON scheduled routine: ${result.split("\n")[0]}`);
    ran.push(r.name);
    if (r.announce) await queueNotice(`Sir, I've run your ${r.name} routine.`);
  }
  return ran;
}

let lastHousekeeping = 0;
async function housekeeping(): Promise<void> {
  const now = new Date();
  if (now.getTime() - lastHousekeeping < 30_000) return;
  lastHousekeeping = now.getTime();
  await runScheduledRoutines(now);
  if ((await getSettings()).billReminders && process.env.GOOGLE_CLIENT_ID) {
    const fresh = await dailyBillScan(now).catch(() => []);
    if (fresh.length) {
      await queueNotice(
        fresh.length === 1
          ? `Sir, a new bill came in: ${describeBill(fresh[0])}. I'll remind you two days before.`
          : `Sir, ${fresh.length} new bills came in — ${fresh.map(describeBill).join("; ")}. I'll remind you before each.`,
      );
    }
  }
}

export const defaultBackgroundDeps: BackgroundDeps = {
  takeFocusDue: () => takeFocusDue(),
  housekeeping,
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
  await deps.housekeeping?.().catch((err) => console.error("ULTRON housekeeping failed:", err));
  if (await deps.pageIsOpen()) return [];
  const due = [
    ...(await deps.takeDue()),
    ...(await deps.checkProactive().catch(() => [])),
    ...((await deps.takeFocusDue?.().catch(() => [])) ?? []),
  ];
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

/** Push-to-talk: tell an open page to listen, or open one that will. */
export async function handleHotkey(): Promise<void> {
  if (emitPageEvent({ type: "listen" }) > 0) return;
  const url = `http://localhost:${process.env.PORT ?? 3000}/?listen=1`;
  await runPowerShell("Start-Process $env:ULTRON_URL", { ULTRON_URL: url }).catch((e) => console.error("ULTRON couldn't open the page:", e));
}

async function onHelperLine(line: HelperLine): Promise<void> {
  if (line.type === "hotkey") return handleHotkey();
  if (line.type === "hotkey-status" && line.status === "taken") {
    console.error("ULTRON: the push-to-talk hotkey is already used by another app — pick another in Settings.");
    return;
  }
  if (line.type === "foreground") {
    if ((await getSettings()).screenTime) await recordSample(line);
    const nudge = await distractionNudge(line);
    if (nudge) await queueNotice(nudge);
  }
}

/** Keeps the desktop helper running with the hotkey from Settings. */
function superviseDesktopHelper(): void {
  let helper: HelperHandle | null = null;
  let hotkey: string | null = null;
  const check = async () => {
    const wanted = (await getSettings()).hotkey;
    if (wanted === hotkey) return;
    helper?.stop();
    hotkey = wanted;
    helper = startDesktopHelper(wanted, (l) => void onHelperLine(l).catch((e) => console.error("ULTRON desktop helper:", e)));
  };
  void check();
  setInterval(() => void check(), 30_000).unref();
}

/** Started once per server process from instrumentation.ts. */
export function startBackgroundLoop(): void {
  const g = globalThis as { __ultronBackground?: boolean };
  if (g.__ultronBackground) return; // dev-mode reloads
  g.__ultronBackground = true;
  superviseDesktopHelper();
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
