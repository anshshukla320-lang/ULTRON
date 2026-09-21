import { promises as fs } from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, ensureWorkspace } from "./workspace";

const MAX_SCAN_DEPTH = 4;
// Google has changed Takeout's location export format more than once
// (Records.json → Semantic Location History monthly files → Timeline.json),
// and as of late 2024 moved Timeline to on-device-only storage, so which of
// these a given export contains varies. Match candidates broadly.
const CANDIDATE_NAME_RE = /^(records|timeline)\.json$/i;
const SEMANTIC_DIR_RE = /semantic location history/i;

interface PlaceVisit {
  location?: { name?: string; address?: string };
  duration?: { startTimestamp?: string; endTimestamp?: string };
}

interface TimelineObject {
  placeVisit?: PlaceVisit;
}

async function findCandidateFiles(dir: string, depth: number, results: string[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && (CANDIDATE_NAME_RE.test(entry.name) || (SEMANTIC_DIR_RE.test(dir) && entry.name.endsWith(".json")))) {
      results.push(full);
    } else if (entry.isDirectory()) {
      await findCandidateFiles(full, depth + 1, results);
    }
  }
}

function summarizeSemanticFile(data: { timelineObjects?: TimelineObject[] }, limit: number): string[] {
  const visits = (data.timelineObjects ?? [])
    .map((o) => o.placeVisit)
    .filter((v): v is PlaceVisit => Boolean(v?.location));
  return visits.slice(-limit).map((v) => {
    const name = v.location?.name ?? v.location?.address ?? "(unnamed place)";
    const when = v.duration?.startTimestamp ? ` (${new Date(v.duration.startTimestamp).toLocaleString()})` : "";
    return `${name}${when}`;
  });
}

/**
 * Reads a user-exported Google Takeout location history file from the
 * agent's sandboxed workspace. There is no live API for this at all —
 * Google discontinued third-party access entirely, and even moved Timeline
 * to on-device-only storage in late 2024 — so this is periodic manual
 * export only, and the exact file format varies by when it was exported.
 */
export async function getRecentLocationHistory(limit = 10): Promise<string> {
  ensureWorkspace();
  const candidates: string[] = [];
  await findCandidateFiles(WORKSPACE_ROOT, 0, candidates);

  if (candidates.length === 0) {
    return (
      `No location history export found in the agent workspace (${WORKSPACE_ROOT}). ` +
      `Google Maps Timeline has no API — export it from https://takeout.google.com under "Location History (Timeline)" ` +
      `(if offered; Google moved Timeline to on-device-only storage in late 2024, so this may not be exportable via ` +
      `Takeout on your account anymore — check your phone's Google Maps Timeline export/backup settings instead), ` +
      `then drop the exported file(s) into that workspace folder.`
    );
  }

  for (const filePath of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    // Semantic Location History monthly files.
    if (parsed && typeof parsed === "object" && "timelineObjects" in parsed) {
      const summary = summarizeSemanticFile(parsed as { timelineObjects?: TimelineObject[] }, limit);
      if (summary.length > 0) {
        return `Recent places from ${path.basename(filePath)}:\n${summary.reverse().join("\n")}`;
      }
    }

    // Older raw Records.json format — no place names, just coordinates, so
    // this can only report how much data exists, not readable locations.
    if (parsed && typeof parsed === "object" && "locations" in parsed) {
      const locations = (parsed as { locations?: unknown[] }).locations ?? [];
      if (locations.length > 0) {
        return (
          `Found ${path.basename(filePath)} with ${locations.length} raw GPS records, but this older export format ` +
          `only has coordinates, not place names — I can't turn that into a readable summary. Re-export from Takeout ` +
          `if a newer "Semantic Location History" format is offered, which includes actual place names.`
        );
      }
    }
  }

  return `Found a location export (${candidates.map((c) => path.basename(c)).join(", ")}) but couldn't recognize its format — Google has changed this export's structure over time.`;
}
