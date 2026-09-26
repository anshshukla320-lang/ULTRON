import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Timers, reminders, and the daily briefing schedule. Kept on disk so they
// survive a server restart; the browser polls /api/reminders to find out
// what's due and says it out loud.

export interface Reminder {
  id: string;
  kind: "timer" | "reminder";
  text: string;
  dueAt: string; // ISO
  createdAt: string;
}

export interface DueItem {
  id: string;
  kind: "timer" | "reminder" | "briefing" | "notice";
  text: string;
}

interface Store {
  items: Reminder[];
  briefing: { time: string; lastFired?: string } | null; // time = "HH:MM" local
}

const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;
// If the PC was off at briefing time, still give it when the app comes up
// within this window — but not a 7:30 briefing at 11pm.
const BRIEFING_GRACE_MS = 4 * 60 * 60 * 1000;

function storePath(): string {
  // Resolved per call so tests can point HOME at a temp dir.
  return path.join(os.homedir(), ".ultron", "reminders.json");
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(), "utf-8"));
    return { items: Array.isArray(parsed.items) ? parsed.items : [], briefing: parsed.briefing ?? null };
  } catch {
    return { items: [], briefing: null };
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2), "utf-8");
}

// The poller and a tool call can touch the file at the same moment; run
// read-modify-write steps one at a time so neither loses the other's change.
let queue: Promise<unknown> = Promise.resolve();
function withStore<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const store = await readStore();
    const result = await fn(store);
    await writeStore(store);
    return result;
  });
  queue = next.catch(() => {});
  return next;
}

function spokenDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s && !h) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.join(" ") || "0 seconds";
}

function spokenTime(d: Date): string {
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? `at ${time}` : `on ${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at ${time}`;
}

export async function setTimer(durationSeconds: number, label?: string): Promise<string> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("duration_seconds must be a positive number.");
  const ms = durationSeconds * 1000;
  if (ms > MAX_DURATION_MS) throw new Error("That's longer than a year — use a reminder with a date instead.");
  const now = Date.now();
  // "your pasta timer is done" / "your 5 minute timer is done"
  const text = label?.trim() || spokenDuration(ms).replace(/(\d+) (hour|minute|second)s\b/g, "$1 $2");
  const reminder: Reminder = { id: randomUUID().slice(0, 8), kind: "timer", text, dueAt: new Date(now + ms).toISOString(), createdAt: new Date(now).toISOString() };
  await withStore((s) => void s.items.push(reminder));
  return `Timer set for ${spokenDuration(ms)}${label ? ` (${label})` : ""} — it goes off ${spokenTime(new Date(reminder.dueAt))}.`;
}

/** `at` is a local date-time like "2026-09-25T17:30" (or any Date-parsable
 *  string); `inMinutes` is relative. Exactly one must be given. */
export async function setReminder(text: string, at?: string, inMinutes?: number): Promise<string> {
  if (!text.trim()) throw new Error("What should I remind you about?");
  let due: Date;
  if (inMinutes !== undefined && Number.isFinite(inMinutes)) {
    if (inMinutes <= 0) throw new Error("in_minutes must be positive.");
    due = new Date(Date.now() + inMinutes * 60_000);
  } else if (at) {
    due = new Date(at);
    if (Number.isNaN(due.getTime())) throw new Error(`Couldn't understand the time "${at}". Use a date-time like 2026-09-25T17:30.`);
    if (due.getTime() <= Date.now()) throw new Error(`${due.toLocaleString()} is already in the past.`);
  } else {
    throw new Error("Give either a time (at) or a delay (in_minutes).");
  }
  if (due.getTime() - Date.now() > MAX_DURATION_MS) throw new Error("That's more than a year away.");
  const reminder: Reminder = { id: randomUUID().slice(0, 8), kind: "reminder", text: text.trim(), dueAt: due.toISOString(), createdAt: new Date().toISOString() };
  await withStore((s) => void s.items.push(reminder));
  return `I'll remind you ${spokenTime(due)}: ${reminder.text}.`;
}

export async function listReminders(): Promise<string> {
  const store = await readStore();
  const lines = [...store.items]
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .map((r) => {
      const left = new Date(r.dueAt).getTime() - Date.now();
      const when = r.kind === "timer" ? `${spokenDuration(Math.max(left, 0))} left` : spokenTime(new Date(r.dueAt));
      return `[${r.id}] ${r.kind}: ${r.text} — ${when}`;
    });
  if (store.briefing) lines.push(`Daily morning briefing at ${store.briefing.time}.`);
  return lines.length ? lines.join("\n") : "No timers or reminders set.";
}

/** Cancels by id, or every item whose text contains the query. */
export async function cancelReminder(query: string): Promise<string> {
  const q = query.trim().toLowerCase();
  if (!q) throw new Error("Say which timer or reminder to cancel.");
  return withStore((s) => {
    const all = q === "all" || q === "everything";
    const keep = s.items.filter((r) => !(all || r.id === q || r.text.toLowerCase().includes(q) || r.kind === q));
    const removed = s.items.length - keep.length;
    s.items = keep;
    return removed ? `Cancelled ${removed} item${removed === 1 ? "" : "s"}.` : `Nothing matching "${query}" to cancel.`;
  });
}

export async function setDailyBriefing(time: string): Promise<string> {
  const t = time.trim().toLowerCase();
  if (["off", "none", "disable", "stop", "cancel"].includes(t)) {
    await withStore((s) => {
      s.briefing = null;
    });
    return "Daily briefing turned off.";
  }
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Use a 24-hour time like 07:30 (got "${time}").`);
  const hhmm = `${m[1].padStart(2, "0")}:${m[2]}`;
  await withStore((s) => {
    // Setting it for later today shouldn't be blocked by an earlier firing.
    s.briefing = { time: hhmm };
  });
  return `Daily briefing set for ${hhmm}. The ULTRON page needs to be open for it to speak.`;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Removes and returns everything that's come due (called by the poller). */
export async function takeDue(now = new Date()): Promise<DueItem[]> {
  return withStore((s) => {
    const due: DueItem[] = [];
    const remaining: Reminder[] = [];
    for (const r of s.items) {
      const dueAt = new Date(r.dueAt);
      if (dueAt.getTime() > now.getTime()) {
        remaining.push(r);
        continue;
      }
      // Delivered late (app was closed): say when it was for.
      const late = now.getTime() - dueAt.getTime() > 2 * 60_000;
      due.push({ id: r.id, kind: r.kind, text: late ? `${r.text} (this was due ${spokenTime(dueAt)})` : r.text });
    }
    s.items = remaining;

    if (s.briefing) {
      const [h, m] = s.briefing.time.split(":").map(Number);
      const scheduled = new Date(now);
      scheduled.setHours(h, m, 0, 0);
      const today = localDateKey(now);
      const elapsed = now.getTime() - scheduled.getTime();
      if (s.briefing.lastFired !== today && elapsed >= 0 && elapsed <= BRIEFING_GRACE_MS) {
        s.briefing.lastFired = today;
        due.push({ id: `briefing-${today}`, kind: "briefing", text: "morning briefing" });
      }
    }
    return due;
  });
}

/** For the control panel. */
export async function listRemindersRaw(): Promise<{ items: Reminder[]; briefingTime: string | null }> {
  const s = await readStore();
  return { items: [...s.items].sort((a, b) => a.dueAt.localeCompare(b.dueAt)), briefingTime: s.briefing?.time ?? null };
}
