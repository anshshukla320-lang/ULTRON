import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DueItem } from "./reminders";
import { appLabel, type ForegroundSample } from "./screenTime";

// Focus mode: Pomodoro-style rounds ("25 minutes on, 5 off, four times"),
// announced at each switch, with a nudge when a distracting app or site
// comes to the front during a focus round.

interface FocusState {
  phase: "focus" | "break";
  endsAt: number;
  focusMinutes: number;
  breakMinutes: number;
  round: number;
  rounds: number;
  task?: string;
  lastNudge?: number;
}

const DISTRACTIONS = /YouTube|Instagram|Facebook|X \/ Twitter|Reddit|Netflix|Prime Video|Hotstar|WhatsApp|Discord|Steam|Telegram|Shopping/;
const NUDGE_EVERY_MS = 5 * 60_000;

function statePath(): string {
  return path.join(os.homedir(), ".ultron", "focus.json");
}

async function read(): Promise<FocusState | null> {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf-8")) as FocusState;
  } catch {
    return null;
  }
}

async function write(s: FocusState | null): Promise<void> {
  if (!s) {
    await fs.rm(statePath(), { force: true });
    return;
  }
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(s), "utf-8");
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

function minutesLeft(s: FocusState, now: number): number {
  return Math.max(1, Math.round((s.endsAt - now) / 60_000));
}

/** start_focus tool. */
export async function startFocus(opts: { minutes?: number; breakMinutes?: number; rounds?: number; task?: string } = {}, now = Date.now()): Promise<string> {
  const focusMinutes = Math.round(Math.min(180, Math.max(5, opts.minutes ?? 25)));
  const breakMinutes = Math.round(Math.min(60, Math.max(1, opts.breakMinutes ?? 5)));
  const rounds = Math.round(Math.min(8, Math.max(1, opts.rounds ?? 1)));
  const task = opts.task?.trim().slice(0, 100) || undefined;
  await serial(() => write({ phase: "focus", endsAt: now + focusMinutes * 60_000, focusMinutes, breakMinutes, round: 1, rounds, task }));
  return `Focus mode on: ${focusMinutes} minutes${rounds > 1 ? `, then ${breakMinutes}-minute breaks, ${rounds} rounds` : ""}${task ? ` on ${task}` : ""}. I'll nudge you if YouTube or social media sneaks in.`;
}

export async function stopFocus(): Promise<string> {
  const s = await read();
  await serial(() => write(null));
  return s ? "Focus mode off." : "Focus mode wasn't on.";
}

export async function focusStatus(now = Date.now()): Promise<string> {
  const s = await read();
  if (!s) return "Focus mode is off.";
  return `${s.phase === "focus" ? "Focusing" : "On a break"}, round ${s.round} of ${s.rounds} — ${minutesLeft(s, now)} min left.`;
}

/** Phase changes that are due (called with the reminder poll / background loop). */
export async function takeFocusDue(now = Date.now()): Promise<DueItem[]> {
  return serial(async () => {
    const s = await read();
    if (!s || now < s.endsAt) return [];
    const id = `focus-${s.round}-${s.phase}`;
    if (s.phase === "focus") {
      if (s.round >= s.rounds) {
        await write(null);
        return [{ id, kind: "notice", text: `Sir, that's the end of your focus session${s.rounds > 1 ? ` — all ${s.rounds} rounds done` : ""}. Well done.` }];
      }
      await write({ ...s, phase: "break", endsAt: now + s.breakMinutes * 60_000 });
      return [{ id, kind: "notice", text: `Round ${s.round} done, sir. Take a ${s.breakMinutes}-minute break.` }];
    }
    await write({ ...s, phase: "focus", round: s.round + 1, endsAt: now + s.focusMinutes * 60_000 });
    return [{ id, kind: "notice", text: `Break's over, sir. Round ${s.round + 1} of ${s.rounds} — ${s.focusMinutes} minutes, starting now.` }];
  });
}

/** A nudge when something distracting is in front during a focus round, or null. */
export async function distractionNudge(sample: Pick<ForegroundSample, "process" | "title" | "idleMs">, now = Date.now()): Promise<string | null> {
  return serial(async () => {
    const s = await read();
    if (!s || s.phase !== "focus" || now >= s.endsAt || sample.idleMs > 60_000) return null;
    const label = appLabel(sample);
    if (!DISTRACTIONS.test(label)) return null;
    if (s.lastNudge && now - s.lastNudge < NUDGE_EVERY_MS) return null;
    await write({ ...s, lastNudge: now });
    const site = label.replace(/ \(.*\)$/, "");
    return `Sir, that's ${site} — you're meant to be focusing${s.task ? ` on ${s.task}` : ""}. ${minutesLeft(s, now)} minutes to go.`;
  });
}
