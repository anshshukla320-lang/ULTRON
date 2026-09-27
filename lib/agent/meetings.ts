import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcribeWav } from "./whisperStt";
import { getSettings } from "./settings";
import { recordUsage } from "./usage";
import { createTask } from "./tasksClient";
import { WORKSPACE_ROOT, ensureWorkspace } from "./workspace";

// Meeting notes: the PC page or the phone records the meeting in ~30 s
// chunks; each is transcribed locally with Whisper as it arrives. At the end
// Claude turns the transcript into a summary, decisions and action items,
// saved as Markdown (in ~/.ultron/meetings and the documents workspace, so
// "what did we decide in Monday's meeting?" finds it).

const SUMMARY_MODEL = "claude-sonnet-5";
const MAX_MINUTES = 180;

interface Meeting {
  id: string;
  title: string;
  startedAt: string;
  chunks: number;
  transcript: string[];
  /** The recorder has sent its last chunk (the page flushes it on "stop"). */
  finalReceived?: boolean;
}

function dir(): string {
  return path.join(os.homedir(), ".ultron", "meetings");
}
function activePath(): string {
  return path.join(dir(), "active.json");
}

async function readActive(): Promise<Meeting | null> {
  try {
    return JSON.parse(await fs.readFile(activePath(), "utf-8")) as Meeting;
  } catch {
    return null;
  }
}

async function writeActive(m: Meeting | null): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  if (m) await fs.writeFile(activePath(), JSON.stringify(m), "utf-8");
  else await fs.rm(activePath(), { force: true });
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

export async function activeMeeting(): Promise<{ id: string; title: string; startedAt: string; minutes: number } | null> {
  const m = await readActive();
  return m ? { id: m.id, title: m.title, startedAt: m.startedAt, minutes: Math.round((Date.now() - new Date(m.startedAt).getTime()) / 60_000) } : null;
}

export async function startMeeting(title = "", now = new Date()): Promise<Meeting> {
  return serial(async () => {
    const existing = await readActive();
    if (existing) return existing; // already recording: keep going
    const m: Meeting = { id: randomUUID().slice(0, 8), title: title.trim().slice(0, 80) || "Meeting", startedAt: now.toISOString(), chunks: 0, transcript: [] };
    await writeActive(m);
    return m;
  });
}

export type Transcriber = (wav: Buffer) => Promise<string>;
const whisper: Transcriber = async (wav) => transcribeWav(wav, (await getSettings()).sttLanguage);

/** One recorded chunk (16 kHz WAV). */
export async function addMeetingChunk(id: string, wav: Buffer, transcribe: Transcriber = whisper, final = false): Promise<{ chunks: number; text: string }> {
  // Transcribe outside the lock (it's the slow part), then append in order.
  const m0 = await readActive();
  if (!m0 || m0.id !== id) throw new Error("That meeting isn't being recorded any more.");
  if (Date.now() - new Date(m0.startedAt).getTime() > MAX_MINUTES * 60_000) throw new Error(`Meetings are limited to ${MAX_MINUTES / 60} hours.`);
  const text = (await transcribe(wav)).trim();
  return serial(async () => {
    const m = await readActive();
    if (!m || m.id !== id) throw new Error("That meeting isn't being recorded any more.");
    m.chunks++;
    if (text) m.transcript.push(text);
    if (final) m.finalReceived = true;
    await writeActive(m);
    return { chunks: m.chunks, text };
  });
}

interface Notes {
  summary: string;
  decisions: string[];
  action_items: { task: string; owner: string; due: string }[];
  spoken: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "4-8 sentence summary of what was discussed." },
    decisions: { type: "array", items: { type: "string" } },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          owner: { type: "string", description: "Who, if said; else empty" },
          due: { type: "string", description: "YYYY-MM-DD if a date was said; else empty" },
        },
        required: ["task", "owner", "due"],
        additionalProperties: false,
      },
    },
    spoken: { type: "string", description: "Two or three sentences ULTRON says out loud: the gist, the number of action items, anything urgent." },
  },
  required: ["summary", "decisions", "action_items", "spoken"],
  additionalProperties: false,
} as const;

export type NoteWriter = (title: string, transcript: string, when: Date) => Promise<Notes>;

const claudeNotes: NoteWriter = async (title, transcript, when) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 4000,
    system: "You write meeting notes from a raw speech-to-text transcript (it has recognition errors and no speaker names). Be accurate: only record what was actually said.",
    messages: [{ role: "user", content: `Meeting: ${title}\nDate: ${when.toDateString()}\n\nTranscript:\n${transcript.slice(0, 150_000)}` }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });
  void recordUsage("chat", SUMMARY_MODEL, response.usage);
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Notes;
};

export function renderNotes(title: string, when: Date, n: Notes, transcript: string): string {
  const date = when.toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" });
  const decisions = n.decisions.length ? n.decisions.map((d) => `- ${d}`).join("\n") : "- None recorded";
  const actions = n.action_items.length
    ? n.action_items.map((a) => `- [ ] ${a.task}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (due ${a.due})` : ""}`).join("\n")
    : "- None";
  return `# ${title}\n\n${date}\n\n## Summary\n${n.summary}\n\n## Decisions\n${decisions}\n\n## Action items\n${actions}\n\n## Transcript\n${transcript}\n`;
}

/** Waits (briefly) for the recorder's last chunk after asking it to stop. */
export async function waitForFinalChunk(maxMs = 15_000): Promise<void> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const m = await readActive();
    if (!m || m.finalReceived) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Ends the recording and writes the notes. Returns what to say. */
export async function stopMeeting(opts: { writer?: NoteWriter; addTasks?: boolean; now?: Date } = {}): Promise<{ spoken: string; file: string } > {
  const m = await serial(async () => {
    const active = await readActive();
    await writeActive(null);
    return active;
  });
  if (!m) throw new Error("No meeting is being recorded.");
  const transcript = m.transcript.join("\n");
  if (transcript.split(/\s+/).length < 15) return { spoken: "I didn't catch enough of that meeting to take notes, sir.", file: "" };
  const started = new Date(m.startedAt);
  const notes = await (opts.writer ?? claudeNotes)(m.title, transcript, started);
  const md = renderNotes(m.title, started, notes, transcript);
  const slug = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")} ${m.title.replace(/[\\/:*?"<>|]+/g, "-")}`;
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), `${slug}.md`), md, "utf-8");
  // A copy where search_documents looks.
  ensureWorkspace();
  const wsDir = path.join(WORKSPACE_ROOT, "Meetings");
  await fs.mkdir(wsDir, { recursive: true });
  const file = path.join(wsDir, `${slug}.md`);
  await fs.writeFile(file, md, "utf-8");
  let spoken = notes.spoken;
  if (opts.addTasks !== false && notes.action_items.length && process.env.GOOGLE_CLIENT_ID) {
    let added = 0;
    for (const a of notes.action_items.slice(0, 10)) {
      try {
        // Google Tasks wants an RFC 3339 timestamp for the due date.
        const due = /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? `${a.due}T00:00:00.000Z` : undefined;
        await createTask(a.task, a.owner ? `Owner: ${a.owner} — from "${m.title}"` : `From "${m.title}"`, due);
        added++;
      } catch {
        break; // Google not connected — the notes still have them
      }
    }
    if (added) spoken += ` I've added ${added} action item${added === 1 ? "" : "s"} to your tasks.`;
  }
  return { spoken, file };
}
