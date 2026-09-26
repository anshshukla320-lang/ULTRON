import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventsStartingWithin } from "./calendarClient";
import { listImportantUnread, type EmailBrief } from "./gmailClient";
import { rainExpectedSoon } from "./weather";
import { formatBytes } from "./diskCleanup";
import type { DueItem } from "./reminders";

// ULTRON speaking up on its own when something needs attention: a meeting
// about to start, an important email, the disk filling up, rain on the
// way. Each thing is announced once, never during quiet hours. Checked from
// the page's reminder poll (so only while ULTRON is open).

export interface ProactiveSources {
  upcomingEvents: (minutes: number) => Promise<{ id: string; summary: string; start: Date }[]>;
  importantUnread: () => Promise<EmailBrief[]>;
  disk: () => Promise<{ freeBytes: number; totalBytes: number }>;
  rain: () => Promise<{ at: Date; chance: number } | null>;
}

export const defaultSources: ProactiveSources = {
  upcomingEvents: (minutes) => eventsStartingWithin(minutes),
  importantUnread: () => listImportantUnread(10),
  disk: async () => {
    const s = await fs.statfs(os.homedir());
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  },
  rain: () => rainExpectedSoon(3),
};

type Check = "calendar" | "email" | "disk" | "rain";
// How often each source is actually queried (the poll runs every ~10s).
const INTERVAL_MS: Record<Check, number> = {
  calendar: 60_000,
  email: 3 * 60_000,
  disk: 60 * 60_000,
  rain: 30 * 60_000,
};
const MEETING_WARNING_MIN = 10;
const LOW_DISK_FRACTION = 0.1;
const LOW_DISK_BYTES = 10 * 1024 ** 3;
const FORGET_AFTER_MS = 3 * 24 * 60 * 60_000;

interface State {
  enabled: boolean;
  quietStart: string | null; // "HH:MM"
  quietEnd: string | null;
  lastRun: Partial<Record<Check, number>>;
  announced: Record<string, number>; // key -> when
  emailBaselineDone: boolean;
}

const DEFAULT_STATE: State = {
  enabled: true,
  quietStart: "22:00",
  quietEnd: "07:00",
  lastRun: {},
  announced: {},
  emailBaselineDone: false,
};

function statePath(): string {
  return path.join(os.homedir(), ".ultron", "proactive.json");
}

async function readState(): Promise<State> {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(await fs.readFile(statePath(), "utf-8")) };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

async function writeState(state: State): Promise<void> {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf-8");
}

let queue: Promise<unknown> = Promise.resolve();
function withState<T>(fn: (s: State) => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const s = await readState();
    const out = await fn(s);
    await writeState(s);
    return out;
  });
  queue = next.catch(() => {});
  return next;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function inQuietHours(now: Date, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  return s <= e ? t >= s && t < e : t >= s || t < e; // may wrap past midnight
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function spokenTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Runs whichever checks are due and returns anything worth saying. Any
 *  source failing (Google not connected, offline) is skipped quietly. */
export async function checkProactive(now = new Date(), sources: ProactiveSources = defaultSources): Promise<DueItem[]> {
  return withState(async (s) => {
    if (!s.enabled) return [];
    const quiet = inQuietHours(now, s.quietStart, s.quietEnd);
    const due = (c: Check) => now.getTime() - (s.lastRun[c] ?? 0) >= INTERVAL_MS[c];
    const notices: DueItem[] = [];
    const announce = (key: string, text: string) => {
      if (s.announced[key]) return;
      s.announced[key] = now.getTime();
      if (!quiet) notices.push({ id: key, kind: "notice", text });
    };

    if (due("calendar")) {
      s.lastRun.calendar = now.getTime();
      try {
        for (const e of await sources.upcomingEvents(MEETING_WARNING_MIN)) {
          const mins = Math.max(1, Math.round((e.start.getTime() - now.getTime()) / 60_000));
          announce(`event:${e.id}:${e.start.toISOString()}`, `Sir, ${e.summary} starts in ${mins} minute${mins === 1 ? "" : "s"}.`);
        }
      } catch {
        // calendar not connected
      }
    }

    if (due("email")) {
      s.lastRun.email = now.getTime();
      try {
        const mail = await sources.importantUnread();
        if (!s.emailBaselineDone) {
          // First run: what's already waiting isn't news.
          for (const m of mail) s.announced[`email:${m.id}`] = now.getTime();
          s.emailBaselineDone = true;
        } else {
          const fresh = mail.filter((m) => !s.announced[`email:${m.id}`]);
          for (const m of fresh) s.announced[`email:${m.id}`] = now.getTime();
          if (fresh.length && !quiet) {
            const [first] = fresh;
            notices.push({
              id: `email:${first.id}`,
              kind: "notice",
              text:
                fresh.length === 1
                  ? `Sir, an important email from ${first.from}: ${first.subject}.`
                  : `Sir, ${fresh.length} new important emails, including one from ${first.from} about ${first.subject}.`,
            });
          }
        }
      } catch {
        // Gmail not connected
      }
    }

    if (due("disk")) {
      s.lastRun.disk = now.getTime();
      try {
        const { freeBytes, totalBytes } = await sources.disk();
        if (totalBytes > 0 && (freeBytes / totalBytes < LOW_DISK_FRACTION || freeBytes < LOW_DISK_BYTES)) {
          announce(
            `disk:${dayKey(now)}`,
            `Sir, your disk is nearly full — ${formatBytes(freeBytes)} left. Say "free up some space" and I'll clear out the junk.`,
          );
        }
      } catch {
        // statfs unsupported
      }
    }

    if (due("rain")) {
      s.lastRun.rain = now.getTime();
      try {
        const rain = await sources.rain();
        if (rain) announce(`rain:${dayKey(now)}`, `Sir, rain is likely around ${spokenTime(rain.at)} — ${rain.chance}% chance.`);
      } catch {
        // offline or no home location
      }
    }

    for (const [key, at] of Object.entries(s.announced)) {
      if (now.getTime() - at > FORGET_AFTER_MS) delete s.announced[key];
    }
    return notices;
  });
}

/** set_proactive tool. */
export async function setProactive(enabled?: boolean, quietHours?: string): Promise<string> {
  return withState(async (s) => {
    if (enabled !== undefined) s.enabled = enabled;
    if (quietHours !== undefined) {
      const q = quietHours.trim().toLowerCase();
      if (["off", "none", ""].includes(q)) {
        s.quietStart = s.quietEnd = null;
      } else {
        const m = q.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (!m) throw new Error(`Quiet hours should look like 22:00-07:00 (got "${quietHours}").`);
        s.quietStart = m[1].padStart(5, "0");
        s.quietEnd = m[2].padStart(5, "0");
      }
    }
    const quiet = s.quietStart ? `quiet from ${s.quietStart} to ${s.quietEnd}` : "no quiet hours";
    return `Proactive notices ${s.enabled ? "on" : "off"} (${quiet}).`;
  });
}
