import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Is an ULTRON page open right now? The page polls /api/reminders every
// ~10 seconds; that poll records the time here. When nothing has polled for
// a while, the background loop takes over announcing things. Kept in a file
// (not a module variable) because the route handler and the background loop
// can be bundled as separate module instances.

const PAGE_TIMEOUT_MS = 25_000;

function presencePath(): string {
  return path.join(os.homedir(), ".ultron", "presence.json");
}

export async function markPageActive(now = Date.now()): Promise<void> {
  try {
    await fs.mkdir(path.dirname(presencePath()), { recursive: true });
    await fs.writeFile(presencePath(), JSON.stringify({ lastPoll: now }), "utf-8");
  } catch {
    // best effort
  }
}

export async function pageIsOpen(now = Date.now()): Promise<boolean> {
  try {
    const { lastPoll } = JSON.parse(await fs.readFile(presencePath(), "utf-8"));
    return now - Number(lastPoll) < PAGE_TIMEOUT_MS;
  } catch {
    return false;
  }
}
