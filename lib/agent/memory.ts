import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Stored outside the agent's file-tool workspace on purpose — same reasoning
// as the OAuth token files: read_file/list_files/search_files are scoped to
// WORKSPACE_ROOT and must never be able to read or overwrite this.
const CONFIG_DIR = path.join(os.homedir(), ".ultron");
const MEMORY_PATH = path.join(CONFIG_DIR, "memory.json");

const MAX_STORED_ENTRIES = 300;
const MAX_PROMPT_ENTRIES = 40;

export interface MemoryEntry {
  text: string;
  savedAt: string;
}

async function readMemory(): Promise<MemoryEntry[]> {
  try {
    const raw = await fs.readFile(MEMORY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMemory(entries: MemoryEntry[]): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(MEMORY_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

export async function rememberFact(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Nothing to remember — the fact was empty.");

  const entries = await readMemory();
  entries.push({ text: trimmed, savedAt: new Date().toISOString() });
  await writeMemory(entries.slice(-MAX_STORED_ENTRIES));
  return `Remembered: "${trimmed}"`;
}

export async function forgetFact(query: string): Promise<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("Give me something to search for before forgetting.");

  const entries = await readMemory();
  const remaining = entries.filter((e) => !e.text.toLowerCase().includes(needle));
  const removed = entries.length - remaining.length;
  if (removed === 0) return `Nothing matching "${query}" found in memory.`;

  await writeMemory(remaining);
  return `Forgot ${removed} memory entr${removed === 1 ? "y" : "ies"} matching "${query}".`;
}

/** Recent memory as a bullet list for injection into a system prompt — the
 *  mechanism that lets the assistant carry what it's learned into future
 *  conversations instead of starting fresh every time. */
export async function recallMemoryForPrompt(): Promise<string> {
  const entries = await readMemory();
  if (entries.length === 0) return "";
  return entries
    .slice(-MAX_PROMPT_ENTRIES)
    .map((e) => `- ${e.text}`)
    .join("\n");
}

function normalizeFact(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** True when two facts say essentially the same thing (most words shared). */
function sameFact(a: string, b: string): boolean {
  const wa = new Set(normalizeFact(a));
  const wb = normalizeFact(b);
  if (wa.size === 0 || wb.length === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const shared = wb.filter((w) => wa.has(w)).length;
  return shared / Math.max(wa.size, wb.length) >= 0.8;
}

/** Saves facts learned automatically from a conversation, skipping any the
 *  memory already holds. Returns how many were new. */
export async function rememberNewFacts(facts: string[]): Promise<number> {
  const entries = await readMemory();
  let added = 0;
  for (const raw of facts) {
    const text = raw.trim();
    if (!text || entries.some((e) => sameFact(e.text, text))) continue;
    entries.push({ text, savedAt: new Date().toISOString() });
    added++;
  }
  if (added) await writeMemory(entries.slice(-MAX_STORED_ENTRIES));
  return added;
}

/** For the control panel. */
export async function listFacts(): Promise<MemoryEntry[]> {
  return readMemory();
}

export async function deleteFactExact(text: string): Promise<boolean> {
  const entries = await readMemory();
  const remaining = entries.filter((e) => e.text !== text);
  if (remaining.length === entries.length) return false;
  await writeMemory(remaining);
  return true;
}

export async function clearAllFacts(): Promise<void> {
  await writeMemory([]);
}
