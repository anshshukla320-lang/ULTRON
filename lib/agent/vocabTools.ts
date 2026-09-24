import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".ultron");
const DECK_PATH = path.join(CONFIG_DIR, "vocab.json");

/** Leitner boxes: a word moves up a box when recalled correctly and back to
 *  box 1 when missed. Each box waits longer before the word is due again. */
const BOX_INTERVAL_DAYS = [1, 3, 7, 14, 30];
const MAX_BOX = BOX_INTERVAL_DAYS.length;
const DAY_MS = 24 * 60 * 60 * 1000;

interface VocabEntry {
  word: string;
  translation: string;
  language: string;
  example?: string;
  box: number;
  dueAt: string;
  addedAt: string;
  correct: number;
  missed: number;
}

async function readDeck(): Promise<VocabEntry[]> {
  try {
    const raw = await fs.readFile(DECK_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeDeck(entries: VocabEntry[]): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(DECK_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

const normalize = (s: string) => s.trim().toLowerCase();

function findEntry(entries: VocabEntry[], word: string, language: string): VocabEntry | undefined {
  return entries.find((e) => normalize(e.word) === normalize(word) && normalize(e.language) === normalize(language));
}

export async function saveVocab(word: string, translation: string, language: string, example?: string): Promise<string> {
  if (!word.trim() || !translation.trim() || !language.trim()) {
    throw new Error("word, translation, and language are all required.");
  }
  const entries = await readDeck();
  const existing = findEntry(entries, word, language);
  if (existing) {
    existing.translation = translation.trim();
    if (example) existing.example = example;
    await writeDeck(entries);
    return `"${existing.word}" was already in your ${existing.language} deck — updated its translation to "${existing.translation}".`;
  }
  const now = new Date();
  entries.push({
    word: word.trim(),
    translation: translation.trim(),
    language: language.trim(),
    example,
    box: 1,
    dueAt: new Date(now.getTime() + BOX_INTERVAL_DAYS[0] * DAY_MS).toISOString(),
    addedAt: now.toISOString(),
    correct: 0,
    missed: 0,
  });
  await writeDeck(entries);
  return `Saved "${word.trim()}" (${translation.trim()}) to your ${language.trim()} deck. First review due tomorrow.`;
}

export async function vocabQuiz(language?: string, count = 5): Promise<string> {
  const entries = await readDeck();
  const pool = language ? entries.filter((e) => normalize(e.language) === normalize(language)) : entries;
  if (pool.length === 0) {
    return language ? `No ${language} words saved yet.` : "Your vocabulary deck is empty.";
  }
  const now = Date.now();
  const due = pool
    .filter((e) => new Date(e.dueAt).getTime() <= now)
    .sort((a, b) => a.box - b.box || new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .slice(0, Math.max(1, Math.min(count, 20)));
  if (due.length === 0) {
    const next = pool.reduce((a, b) => (new Date(a.dueAt) < new Date(b.dueAt) ? a : b));
    return `Nothing due for review. Next word ("${next.word}") comes up ${new Date(next.dueAt).toDateString()}.`;
  }
  const lines = due.map(
    (e, i) => `${i + 1}. [${e.language}] ${e.word} = ${e.translation}${e.example ? ` (example: ${e.example})` : ""} — box ${e.box}/${MAX_BOX}`,
  );
  return `${due.length} word(s) due. Answers are included for grading only — ask one at a time and don't reveal the answer first:\n${lines.join("\n")}`;
}

export async function vocabResult(word: string, language: string, correct: boolean): Promise<string> {
  const entries = await readDeck();
  const entry = findEntry(entries, word, language);
  if (!entry) throw new Error(`"${word}" isn't in your ${language} deck.`);
  if (correct) {
    entry.correct += 1;
    entry.box = Math.min(entry.box + 1, MAX_BOX);
  } else {
    entry.missed += 1;
    entry.box = 1;
  }
  const days = BOX_INTERVAL_DAYS[entry.box - 1];
  entry.dueAt = new Date(Date.now() + days * DAY_MS).toISOString();
  await writeDeck(entries);
  return correct
    ? `"${entry.word}" moved to box ${entry.box}; next review in ${days} day(s).`
    : `"${entry.word}" back to box 1; it'll come up again tomorrow.`;
}

export async function vocabSummary(language?: string): Promise<string> {
  const entries = await readDeck();
  const pool = language ? entries.filter((e) => normalize(e.language) === normalize(language)) : entries;
  if (pool.length === 0) {
    return language ? `No ${language} words saved yet.` : "Your vocabulary deck is empty.";
  }
  const now = Date.now();
  const byLanguage = new Map<string, VocabEntry[]>();
  for (const e of pool) {
    const key = e.language;
    byLanguage.set(key, [...(byLanguage.get(key) ?? []), e]);
  }
  const lines = [...byLanguage.entries()].map(([lang, list]) => {
    const due = list.filter((e) => new Date(e.dueAt).getTime() <= now).length;
    const mastered = list.filter((e) => e.box === MAX_BOX).length;
    const reviews = list.reduce((n, e) => n + e.correct + e.missed, 0);
    const right = list.reduce((n, e) => n + e.correct, 0);
    const accuracy = reviews ? ` Accuracy ${Math.round((right / reviews) * 100)}%.` : "";
    return `${lang}: ${list.length} word${list.length === 1 ? "" : "s"}, ${due} due now, ${mastered} mastered.${accuracy}`;
  });
  return lines.join("\n");
}
