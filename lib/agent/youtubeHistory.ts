import { promises as fs } from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, ensureWorkspace } from "./workspace";

const TARGET_FILENAME = "watch-history.json";
const MAX_SCAN_DEPTH = 3;

interface TakeoutEntry {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: { name?: string }[];
  time?: string;
}

async function findHistoryFile(dir: string, depth: number): Promise<string | null> {
  if (depth > MAX_SCAN_DEPTH) return null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === TARGET_FILENAME) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findHistoryFile(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Reads a user-exported Google Takeout watch-history.json from the agent's
 * sandboxed workspace. There's no live API for this — Google deprecated
 * watch-history access in 2016 — so this is a periodic manual export, not
 * real-time.
 */
export async function getRecentWatchHistory(limit = 10): Promise<string> {
  ensureWorkspace();
  const filePath = await findHistoryFile(WORKSPACE_ROOT, 0);
  if (!filePath) {
    return (
      `No ${TARGET_FILENAME} found in the agent workspace (${WORKSPACE_ROOT}). ` +
      `Export it from https://takeout.google.com — deselect everything except "YouTube and YouTube Music", ` +
      `then under its options include only "history" — extract the download and drop the watch-history.json ` +
      `file (or the whole extracted folder) into that workspace folder.`
    );
  }

  const raw = await fs.readFile(filePath, "utf-8");
  let entries: TakeoutEntry[];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error(`Couldn't parse ${path.basename(filePath)} — is it a valid Takeout watch-history.json export?`);
  }

  const watched = entries
    .filter((e) => e.titleUrl && e.title)
    .sort((a, b) => new Date(b.time ?? 0).getTime() - new Date(a.time ?? 0).getTime())
    .slice(0, limit);

  if (watched.length === 0) return "No watch history entries found in the export.";

  return watched
    .map((e, i) => {
      const title = (e.title ?? "").replace(/^Watched\s+/i, "");
      const channel = e.subtitles?.[0]?.name ? ` — ${e.subtitles[0].name}` : "";
      const when = e.time ? ` (${new Date(e.time).toLocaleString()})` : "";
      return `${i + 1}. ${title}${channel}${when}`;
    })
    .join("\n");
}
