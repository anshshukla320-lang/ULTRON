import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { jsonStore } from "./jsonStore";
import { emitPageEvent } from "./events";
import { logNotices } from "./noticeLog";

// Home security mode: while the user is out (the phone tells the PC when it
// leaves home, or they say "security mode on"), the ULTRON page on the PC
// watches the webcam. If a face appears, it sends a snapshot here and the
// owner's phone gets a notification with the photo. Nothing is said out
// loud on the PC — the person in the room isn't the one to warn.

const MIN_ALERT_GAP_MS = 2 * 60_000;
const KEEP_PHOTOS = 50;

interface Store {
  on: boolean;
  since?: string;
  by?: string;
  /** The phone says the user isn't home (also used for "left on while you're out"). */
  away: boolean;
  lastAlertAt?: number;
}
const store = jsonStore<Store>("security.json", () => ({ on: false, away: false }));

function photoDir(): string {
  return path.join(os.homedir(), ".ultron", "security");
}

export async function securityState(): Promise<Store> {
  return store.read();
}

export async function isAway(): Promise<boolean> {
  const s = await store.read();
  return s.away || s.on;
}

/** Turns security mode on/off; returns what to tell the user. */
export async function setSecurityMode(on: boolean, by: "voice" | "phone" | "page" = "voice", now = new Date()): Promise<string> {
  await store.update((s) => {
    s.on = on;
    s.since = now.toISOString();
    s.by = by;
    if (!on && by !== "phone") s.away = false;
  });
  const pages = emitPageEvent({ type: "security", on });
  if (!on) return "Security mode is off.";
  return pages > 0
    ? "Security mode is on: the PC's webcam is watching, and your phone gets a photo if anyone shows up."
    : "Security mode is on, but no ULTRON page is open on the PC to watch the webcam — leave it open (on this PC) for the camera to work.";
}

/** From the phone: it left home / came back. */
export async function phoneAway(away: boolean, autoSecurity: boolean, now = new Date()): Promise<string> {
  const s = await store.read();
  await store.update((x) => void (x.away = away));
  if (!autoSecurity) return away ? "Noted that you're out." : "Welcome home.";
  if (away && !s.on) return setSecurityMode(true, "phone", now);
  // Only switch off what the phone switched on.
  if (!away && s.on && s.by === "phone") return setSecurityMode(false, "phone", now);
  return "No change.";
}

export interface AlertDeps {
  phoneNotice: (text: string, image: string) => Promise<void>;
  telegram: (text: string) => Promise<void>;
}
const defaultAlertDeps: AlertDeps = {
  phoneNotice: (text, image) => logNotices([{ kind: "notice", title: "Security alert", text, image }]),
  // Loaded lazily: the Telegram bot module pulls in the agent (and its tools).
  telegram: async (text) => (await import("./telegram")).notifyTelegram(text),
};

/** A snapshot from the page's webcam watcher. Returns false when ignored. */
export async function recordIntruder(jpeg: Buffer, now = Date.now(), deps: AlertDeps = defaultAlertDeps): Promise<boolean> {
  if (jpeg.length < 100 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Expected a JPEG.");
  const s = await store.read();
  if (!s.on) return false;
  if (s.lastAlertAt && now - s.lastAlertAt < MIN_ALERT_GAP_MS) return false;
  await store.update((x) => void (x.lastAlertAt = now));
  const id = `${now}-${randomUUID().slice(0, 6)}`;
  await fs.mkdir(photoDir(), { recursive: true });
  await fs.writeFile(path.join(photoDir(), `${id}.jpg`), jpeg);
  const files = (await fs.readdir(photoDir())).filter((f) => f.endsWith(".jpg")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_PHOTOS))) await fs.rm(path.join(photoDir(), old), { force: true });
  const when = new Date(now).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const text = `Someone is at your PC (${when}) while security mode is on.`;
  await deps.phoneNotice(text, id);
  await deps.telegram(`ULTRON security: ${text}`).catch(() => {});
  return true;
}

/** A saved snapshot, by id (only ids this module made). */
export async function readSecurityPhoto(id: string): Promise<Buffer | null> {
  if (!/^\d+-[0-9a-f]{6}$/.test(id)) return null;
  try {
    return await fs.readFile(path.join(photoDir(), `${id}.jpg`));
  } catch {
    return null;
  }
}
