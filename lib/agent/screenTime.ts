import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Screen time: which app is in front, sampled every ~15 s by the desktop
// helper, added up per day. Only app names (and, for browsers, a handful of
// well-known sites) are kept — never window titles. All on this PC.

export interface ForegroundSample {
  process: string;
  title: string;
  idleMs: number;
}

const IDLE_CUTOFF_MS = 2 * 60_000; // away from the keyboard: not screen time
const MAX_GAP_S = 30; // never count more than this per sample (sleep, restarts)

const APP_NAMES: Record<string, string> = {
  chrome: "Chrome",
  msedge: "Edge",
  firefox: "Firefox",
  brave: "Brave",
  opera: "Opera",
  code: "VS Code",
  winword: "Word",
  excel: "Excel",
  powerpnt: "PowerPoint",
  outlook: "Outlook",
  olk: "Outlook",
  explorer: "File Explorer",
  whatsapp: "WhatsApp",
  "whatsapp.root": "WhatsApp",
  spotify: "Spotify",
  discord: "Discord",
  teams: "Teams",
  "ms-teams": "Teams",
  zoom: "Zoom",
  slack: "Slack",
  notepad: "Notepad",
  windowsterminal: "Terminal",
  cmd: "Command Prompt",
  powershell: "PowerShell",
  vlc: "VLC",
  steam: "Steam",
  telegram: "Telegram",
  acrobat: "Acrobat",
  acrord32: "Acrobat Reader",
};
const BROWSERS = new Set(["chrome", "msedge", "firefox", "brave", "opera"]);
// Sites worth telling apart inside a browser — matched on the tab title.
const SITES: [RegExp, string][] = [
  [/youtube/i, "YouTube"],
  [/instagram/i, "Instagram"],
  [/facebook/i, "Facebook"],
  [/\/ X$|twitter/i, "X / Twitter"],
  [/reddit/i, "Reddit"],
  [/netflix/i, "Netflix"],
  [/prime video/i, "Prime Video"],
  [/hotstar/i, "Hotstar"],
  [/whatsapp/i, "WhatsApp Web"],
  [/gmail|inbox/i, "Gmail"],
  [/linkedin/i, "LinkedIn"],
  [/chatgpt|claude/i, "AI chat"],
  [/github/i, "GitHub"],
  [/stack overflow/i, "Stack Overflow"],
  [/google docs|google sheets|google slides/i, "Google Docs"],
  [/amazon|flipkart/i, "Shopping"],
];

export function appLabel(s: Pick<ForegroundSample, "process" | "title">): string {
  const proc = s.process.toLowerCase().replace(/\.exe$/, "");
  const app = APP_NAMES[proc] ?? (s.process ? s.process.replace(/\.exe$/i, "") : "Unknown");
  if (BROWSERS.has(proc)) {
    const site = SITES.find(([re]) => re.test(s.title));
    if (site) return `${site[1]} (${app})`;
  }
  return app;
}

function dayFile(d: Date): string {
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(os.homedir(), ".ultron", "screentime", `${key}.json`);
}

async function readDay(d: Date): Promise<Record<string, number>> {
  try {
    return JSON.parse(await fs.readFile(dayFile(d), "utf-8"));
  } catch {
    return {};
  }
}

let lastSampleAt = 0;

/** Adds the time since the previous sample to the app now in front. */
export async function recordSample(s: ForegroundSample, now = new Date()): Promise<void> {
  const gap = lastSampleAt ? Math.min(MAX_GAP_S, (now.getTime() - lastSampleAt) / 1000) : 0;
  lastSampleAt = now.getTime();
  if (gap <= 0 || s.idleMs > IDLE_CUTOFF_MS || !s.process) return;
  const day = await readDay(now);
  const label = appLabel(s);
  day[label] = Math.round((day[label] ?? 0) + gap);
  await fs.mkdir(path.dirname(dayFile(now)), { recursive: true });
  await fs.writeFile(dayFile(now), JSON.stringify(day), "utf-8");
}

/** Test hook. */
export function resetScreenTimeClock(): void {
  lastSampleAt = 0;
}

function hm(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** screen_time_report tool: "today", "yesterday" or "week". */
export async function screenTimeReport(period = "today", now = new Date()): Promise<string> {
  const p = period.trim().toLowerCase();
  const days: Date[] = [];
  if (p === "yesterday") days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  else if (p === "week") for (let i = 0; i < 7; i++) days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
  else days.push(now);
  const totals: Record<string, number> = {};
  for (const d of days) for (const [app, s] of Object.entries(await readDay(d))) totals[app] = (totals[app] ?? 0) + s;
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((n, [, s]) => n + s, 0);
  const label = p === "week" ? "the last 7 days" : p === "yesterday" ? "yesterday" : "today";
  if (total < 60) return `No screen time recorded for ${label}. (It's recorded while ULTRON is running, with Screen time on in Settings.)`;
  const lines = sorted.slice(0, 10).map(([app, s]) => `${app}: ${hm(s)}`);
  return `Screen time ${label}: ${hm(total)} in total${p === "week" ? ` (about ${hm(total / 7)} a day)` : ""}.\n${lines.join("\n")}`;
}
