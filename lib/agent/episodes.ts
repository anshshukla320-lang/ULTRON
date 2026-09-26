import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rememberNewFacts } from "./memory";

// Episodic memory: a short summary of every finished conversation, so
// ULTRON can pick up threads later ("how did the interview go?") the way a
// person would, without the whole transcript being resent forever.

export interface Episode {
  id: string;
  at: string; // ISO time the conversation ended
  summary: string;
  mood?: string;
}

// Cheap and fast: this runs in the background after each conversation.
const SUMMARY_MODEL = "claude-haiku-4-5";
const MAX_EPISODES = 500;
const PROMPT_EPISODES = 5;

function episodesPath(): string {
  return path.join(os.homedir(), ".ultron", "episodes.json");
}

async function readEpisodes(): Promise<Episode[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(episodesPath(), "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();
async function appendEpisode(episode: Episode): Promise<void> {
  const next = queue.then(async () => {
    const all = await readEpisodes();
    all.push(episode);
    await fs.mkdir(path.dirname(episodesPath()), { recursive: true });
    await fs.writeFile(episodesPath(), JSON.stringify(all.slice(-MAX_EPISODES), null, 2), "utf-8");
  });
  queue = next.catch(() => {});
  return next;
}

function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString("en-US", { weekday: "long" })} ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The last few conversation summaries, for the (uncached) system block. */
export async function recentEpisodesForPrompt(now = new Date()): Promise<string> {
  const recent = (await readEpisodes()).slice(-PROMPT_EPISODES);
  return recent.map((e) => `- ${whenLabel(e.at, now)}: ${e.summary}${e.mood ? ` (user seemed ${e.mood})` : ""}`).join("\n");
}

/** recall_conversations: keyword search over every stored summary. */
export async function searchEpisodes(query: string, limit = 8): Promise<string> {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) throw new Error("Give me something to search for.");
  const scored = (await readEpisodes())
    .map((e) => {
      const hay = `${e.summary} ${e.mood ?? ""}`.toLowerCase();
      return { e, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.at.localeCompare(a.e.at))
    .slice(0, limit);
  if (scored.length === 0) return `No past conversations mention "${query}".`;
  return scored.map(({ e }) => `${whenLabel(e.at)}: ${e.summary}`).join("\n");
}

/** Plain-text transcript of what was actually said (tool traffic reduced to
 *  one line per action), which is all the summarizer needs. */
export function transcriptOf(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      lines.push(`${m.role === "user" ? "User" : "ULTRON"}: ${m.content}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) lines.push(`${m.role === "user" ? "User" : "ULTRON"}: ${b.text.trim()}`);
      else if (b.type === "tool_use") lines.push(`(ULTRON used ${b.name})`);
    }
  }
  return lines.join("\n").slice(-20_000);
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "1-2 sentences in third person about what the user wanted or talked about and what happened. Empty string if nothing worth remembering.",
    },
    mood: {
      type: "string",
      description: "One or two words for the user's apparent mood if it clearly showed (e.g. 'stressed', 'cheerful'); empty string otherwise.",
    },
    facts: {
      type: "array",
      items: { type: "string" },
      description: "Durable facts about the user worth remembering in future conversations (preferences, people, plans, circumstances). No one-off requests, no time-sensitive data. Often empty.",
    },
  },
  required: ["summary", "mood", "facts"],
  additionalProperties: false,
} as const;

interface Summary {
  summary: string;
  mood: string;
  facts: string[];
}

/**
 * Summarizes a finished conversation into an episode, and saves any lasting
 * facts about the user into long-term memory. Trivial exchanges (a single
 * "open notepad") are skipped.
 */
export async function consolidateConversation(
  client: Pick<Anthropic, "messages">,
  messages: Anthropic.MessageParam[],
  now = new Date(),
): Promise<{ episode: Episode | null; factsAdded: number }> {
  const transcript = transcriptOf(messages);
  const userWords = messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .reduce((n, m) => n + (m.content as string).split(/\s+/).length, 0);
  if (userWords < 6) return { episode: null, factsAdded: 0 };

  const response = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 1024,
    system:
      "You maintain the long-term memory of a personal voice assistant called ULTRON. Summarize the conversation you're given. Be factual and concise; never invent details.",
    messages: [{ role: "user", content: `Conversation (${now.toLocaleString("en-US")}):\n\n${transcript}` }],
    output_config: { format: { type: "json_schema", schema: SUMMARY_SCHEMA } },
  });
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(text) as Partial<Summary>;

  const factsAdded = await rememberNewFacts(Array.isArray(parsed.facts) ? parsed.facts.map(String) : []);
  const summary = String(parsed.summary ?? "").trim();
  if (!summary) return { episode: null, factsAdded };
  const episode: Episode = { id: randomUUID().slice(0, 8), at: now.toISOString(), summary, ...(parsed.mood?.trim() ? { mood: parsed.mood.trim() } : {}) };
  await appendEpisode(episode);
  return { episode, factsAdded };
}
