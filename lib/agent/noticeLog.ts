import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DueItem } from "./reminders";

// Everything ULTRON announces (timers, reminders, notices, briefings) is
// also written here, numbered, so the phone app can fetch what it hasn't
// shown yet and raise it as a phone notification — even when the PC said it
// out loud to an empty room.

export interface LoggedNotice {
  seq: number;
  at: string;
  kind: DueItem["kind"];
  title: string;
  text: string;
  /** A photo to show with it (security mode): fetched from /api/security/photo?id=… */
  image?: string;
}

const KEEP = 300;

function logPath(): string {
  return path.join(os.homedir(), ".ultron", "notice-log.json");
}

async function readLog(): Promise<LoggedNotice[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(logPath(), "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Spoken/written line for one due item (same wording as the page uses). */
export function lineFor(item: { kind: DueItem["kind"]; text: string; id?: string }): string {
  if (item.kind === "timer") return `Sir, your ${item.text} timer is done.`;
  if (item.kind === "reminder") return `Sir, a reminder: ${item.text}.`;
  if (item.kind === "briefing") return "Your morning briefing is ready, sir.";
  return item.text;
}

export function titleFor(kind: DueItem["kind"]): string {
  return kind === "timer" ? "Timer done" : kind === "reminder" ? "Reminder" : kind === "briefing" ? "Morning briefing" : "ULTRON";
}

/** Records announced items with the words that were (or will be) spoken. */
export function logNotices(items: { kind: DueItem["kind"]; text: string; title?: string; image?: string }[], now = new Date()): Promise<void> {
  if (!items.length) return Promise.resolve();
  const next = queue.then(async () => {
    const log = await readLog();
    let seq = log.at(-1)?.seq ?? 0;
    for (const i of items) log.push({ seq: ++seq, at: now.toISOString(), kind: i.kind, title: i.title ?? titleFor(i.kind), text: i.text, ...(i.image ? { image: i.image } : {}) });
    await fs.mkdir(path.dirname(logPath()), { recursive: true });
    await fs.writeFile(logPath(), JSON.stringify(log.slice(-KEEP)), "utf-8");
  });
  queue = next.catch(() => {});
  return next;
}

/** Notices after `after` (a seq number), oldest first. */
export async function noticesAfter(after: number, max = 20): Promise<{ items: LoggedNotice[]; latest: number }> {
  const log = await readLog();
  return { items: log.filter((n) => n.seq > after).slice(-max), latest: log.at(-1)?.seq ?? 0 };
}

/** Notices from one local day, for the evening recap. */
export async function noticesOn(day: Date): Promise<LoggedNotice[]> {
  const key = day.toDateString();
  return (await readLog()).filter((n) => new Date(n.at).toDateString() === key);
}
