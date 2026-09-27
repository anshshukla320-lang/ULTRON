import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listEpisodes } from "./episodes";
import { noticesOn } from "./noticeLog";
import { screenTimeReport } from "./screenTime";
import { readHealth, describeDay } from "./health";
import { recordUsage } from "./usage";
import { habitsDoneOn } from "./habits";
import { readLedger, money } from "./financeTools";

// A private journal, one Markdown file per day in ~/.ultron/journal:
// things the user asks to note ("note in my journal: …"), plus an evening
// recap ULTRON writes itself from the day's conversations, reminders,
// meetings, screen time and health. "What did I do last Tuesday?" reads it.

const RECAP_MODEL = "claude-haiku-4-5";

function dir(): string {
  return path.join(os.homedir(), ".ultron", "journal");
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fileFor(key: string): string {
  return path.join(dir(), `${key}.md`);
}

async function read(key: string): Promise<string> {
  try {
    return await fs.readFile(fileFor(key), "utf-8");
  } catch {
    return "";
  }
}

async function write(key: string, text: string): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(fileFor(key), text, "utf-8");
}

const RECAP_HEADING = "## Recap";
const NOTES_HEADING = "## Notes";

/** Splits a day file into its recap and its notes. */
export function parseDay(text: string): { recap: string; notes: string[] } {
  const recap = text.match(/## Recap\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  const notes = (text.match(/## Notes\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
  return { recap, notes };
}

function render(key: string, recap: string, notes: string[]): string {
  const date = new Date(`${key}T12:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  let out = `# ${date}\n`;
  if (recap) out += `\n${RECAP_HEADING}\n${recap}\n`;
  if (notes.length) out += `\n${NOTES_HEADING}\n${notes.map((n) => `- ${n}`).join("\n")}\n`;
  return out;
}

/** journal_add tool. */
export async function addJournalEntry(text: string, now = new Date()): Promise<string> {
  const t = text.trim();
  if (!t) throw new Error("What should I write down?");
  const key = dayKey(now);
  const day = parseDay(await read(key));
  const time = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  day.notes.push(`${time} — ${t}`);
  await write(key, render(key, day.recap, day.notes));
  return `Noted in today's journal.`;
}

/** Accepts "today", "yesterday", "2026-09-22", "last tuesday", "22 sept". */
export function resolveDay(input: string, now = new Date()): Date {
  const s = input.trim().toLowerCase();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (!s || s === "today") return base;
  if (s === "yesterday") return new Date(base.getTime() - 86_400_000);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const wd = s.replace(/^(last|on)\s+/, "");
  const i = days.findIndex((d) => d.startsWith(wd.slice(0, 3)) && wd.length >= 3);
  if (i >= 0) {
    let back = (base.getDay() - i + 7) % 7;
    if (back === 0) back = 7; // "tuesday" on a Tuesday means last week's
    return new Date(base.getTime() - back * 86_400_000);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00`);
  // "22 sept" / "sept 22" — a day number and a month name, nothing looser
  // (the built-in parser happily reads "the day after never" as a date).
  const month = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(s);
  const dayNum = /\b([12]?\d|3[01])(st|nd|rd|th)?\b/.exec(s);
  const parsed = month && dayNum ? new Date(`${month[1]} ${dayNum[1]} ${now.getFullYear()}`) : new Date(NaN);
  if (!Number.isNaN(parsed.getTime())) {
    const d = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12);
    return d.getTime() > now.getTime() ? new Date(d.getFullYear() - 1, d.getMonth(), d.getDate(), 12) : d;
  }
  throw new Error(`Couldn't tell which day "${input}" is.`);
}

/** journal_read tool. */
export async function readJournal(day: string, now = new Date()): Promise<string> {
  const d = resolveDay(day, now);
  const text = await read(dayKey(d));
  return text.trim() ? text : `Nothing in the journal for ${d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}.`;
}

/** journal_search tool: days whose recap or notes mention the words. */
export async function searchJournal(query: string): Promise<string> {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) throw new Error("What should I look for?");
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir())).filter((f) => f.endsWith(".md")).sort().reverse();
  } catch {
    return "The journal is empty so far.";
  }
  const hits: string[] = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(dir(), f), "utf-8");
    const lower = text.toLowerCase();
    if (words.every((w) => lower.includes(w))) {
      const lines = text.split("\n").filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 3);
      hits.push(`${f.slice(0, -3)}: ${lines.join(" … ")}`);
    }
    if (hits.length >= 8) break;
  }
  return hits.length ? hits.join("\n") : `Nothing in the journal mentions "${query}".`;
}

/** Everything known about a day, as raw material for the recap. */
export async function gatherDay(day: Date): Promise<string> {
  const key = dayKey(day);
  const sections: string[] = [];
  const episodes = (await listEpisodes()).filter((e) => dayKey(new Date(e.at)) === key);
  if (episodes.length) sections.push(`Conversations with ULTRON:\n${episodes.map((e) => `- ${e.summary}${e.mood ? ` (mood: ${e.mood})` : ""}`).join("\n")}`);
  const notices = await noticesOn(day);
  if (notices.length) sections.push(`Reminders and notices:\n${notices.map((n) => `- ${n.text}`).join("\n")}`);
  const screen = await screenTimeReport("today", day);
  if (!screen.startsWith("No screen time")) sections.push(screen);
  const health = (await readHealth()).find((h) => h.date === key);
  if (health) sections.push(`Health: ${describeDay(health)}`);
  const habits = await habitsDoneOn(key);
  if (habits.length) sections.push(`Habits done: ${habits.join(", ")}`);
  const spent = (await readLedger()).filter((e) => dayKey(new Date(e.loggedAt)) === key);
  if (spent.length) sections.push(`Spending: ${spent.map((e) => `${money(e.amount)} ${e.note ?? e.category}`).join(", ")}`);
  const notes = parseDay(await read(key)).notes;
  if (notes.length) sections.push(`The user's own journal notes:\n${notes.map((n) => `- ${n}`).join("\n")}`);
  try {
    const meetings = await fs.readdir(path.join(os.homedir(), ".ultron", "meetings"));
    const today = meetings.filter((m) => m.startsWith(key) && m.endsWith(".md"));
    for (const m of today) {
      const text = await fs.readFile(path.join(os.homedir(), ".ultron", "meetings", m), "utf-8");
      sections.push(`Meeting notes:\n${text.split("\n## Transcript")[0].slice(0, 1500)}`);
    }
  } catch {
    // no meetings yet
  }
  return sections.join("\n\n");
}

export type RecapWriter = (material: string, day: Date) => Promise<string>;

const claudeRecap: RecapWriter = async (material, day) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: RECAP_MODEL,
    max_tokens: 700,
    system:
      "You write a short, warm evening recap of the user's day for their private journal, in second person ('You started the day…'). 80-150 words, plain prose, no lists or headings. Only use what's in the material; never invent. Mention anything left to do tomorrow if the material says so.",
    messages: [{ role: "user", content: `Day: ${day.toDateString()}\n\n${material}` }],
  });
  void recordUsage("background", RECAP_MODEL, response.usage);
  return response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
};

/** day_recap tool / the evening job: writes (or rewrites) a day's recap. */
export async function writeRecap(dayInput: string | Date = "today", now = new Date(), writer: RecapWriter = claudeRecap): Promise<string> {
  const day = typeof dayInput === "string" ? resolveDay(dayInput, now) : dayInput;
  const material = await gatherDay(day);
  if (!material.trim()) return "There's nothing recorded for that day to recap yet.";
  const recap = await writer(material, day);
  const key = dayKey(day);
  const existing = parseDay(await read(key));
  await write(key, render(key, recap, existing.notes));
  return recap;
}

let lastAutoRecap = "";

/** From the background loop: the evening recap once a day at the set time. */
export async function eveningRecapDue(time: string, now = new Date()): Promise<boolean> {
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(":").map(Number);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  const key = dayKey(now);
  const late = now.getTime() - at.getTime();
  if (late < 0 || late > 3 * 60 * 60_000 || lastAutoRecap === key) return false;
  lastAutoRecap = key;
  // Already written today (e.g. the server restarted): don't redo it.
  return !parseDay(await read(key)).recap;
}
