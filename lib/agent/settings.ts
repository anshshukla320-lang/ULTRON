import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything the control panel (/settings) can switch. Stored beside the
// other ~/.ultron files so it survives restarts and updates.

export interface Settings {
  /** Let Sonnet consult Opus 5 on hard questions (ULTRON_ADVISOR=off overrides). */
  advisor: boolean;
  /** Speak reminders/notices through the PC's speakers when no ULTRON page is open. */
  backgroundSpeech: boolean;
  /** Windows notifications when no page is open. */
  backgroundNotifications: boolean;
  /** "browser" = Chrome's speech recognition; "whisper" = local whisper.cpp. */
  sttEngine: "browser" | "whisper";
  /** Language to listen for. "auto" only works with Whisper. */
  sttLanguage: "en" | "hi" | "auto";
  /** Allow operate_computer (still asks for confirmation every time). */
  computerUse: boolean;
  /** Also send background notices to the owner's Telegram (if the bot is set up). */
  telegramNotifications: boolean;
  /** Daily spending cap in USD for the Claude API; 0 = no cap. */
  dailyBudgetUsd: number;
  /** Piper voice name (e.g. "en_GB-alan-medium"); "" = the default voice. */
  voice: string;
  /** Speaking speed, 0.7 (slow) – 1.5 (fast). */
  voiceSpeed: number;
  /** Global push-to-talk hotkey, e.g. "Ctrl+Shift+Space"; "" = off. */
  hotkey: string;
  /** Only obey the enrolled owner's voice (Whisper hearing only). */
  voiceLock: boolean;
  /** How similar a voice must be to the owner's to count (0.3 lenient – 0.9 strict). */
  voiceLockThreshold: number;
  /** Watch the webcam (on this PC only) to greet the user and notice them leaving. */
  webcamPresence: boolean;
  /** Lock the PC after this many minutes away (webcam presence); 0 = never. */
  presenceLockMinutes: number;
  /** Keep a local record of which apps are used, for screen-time reports. */
  screenTime: boolean;
  /** Stocks to mention in the morning briefing, e.g. ["RELIANCE.NS", "TCS.NS"]. */
  stockWatchlist: string[];
  /** Include top headlines in the morning briefing. */
  newsInBriefing: boolean;
  /** Scan Gmail daily for bills and set reminders before they're due. */
  billReminders: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  advisor: true,
  backgroundSpeech: true,
  backgroundNotifications: true,
  sttEngine: "browser",
  sttLanguage: "en",
  computerUse: true,
  telegramNotifications: true,
  dailyBudgetUsd: 0,
  voice: "",
  voiceSpeed: 1,
  hotkey: "Ctrl+Shift+Space",
  voiceLock: false,
  voiceLockThreshold: 0.5,
  webcamPresence: false,
  presenceLockMinutes: 0,
  screenTime: true,
  stockWatchlist: [],
  newsInBriefing: true,
  billReminders: true,
};

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function settingsPath(): string {
  return path.join(os.homedir(), ".ultron", "settings.json");
}

export async function getSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(), "utf-8"));
    return sanitize({ ...DEFAULT_SETTINGS, ...raw });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function sanitize(s: Settings): Settings {
  return {
    advisor: s.advisor !== false,
    backgroundSpeech: s.backgroundSpeech !== false,
    backgroundNotifications: s.backgroundNotifications !== false,
    sttEngine: s.sttEngine === "whisper" ? "whisper" : "browser",
    sttLanguage: s.sttLanguage === "hi" || s.sttLanguage === "auto" ? s.sttLanguage : "en",
    computerUse: s.computerUse !== false,
    telegramNotifications: s.telegramNotifications !== false,
    dailyBudgetUsd: Number.isFinite(Number(s.dailyBudgetUsd)) && Number(s.dailyBudgetUsd) > 0 ? Number(s.dailyBudgetUsd) : 0,
    voice: typeof s.voice === "string" && /^[a-z]{2,3}_[A-Z]{2}-[\w]+-(x_low|low|medium|high)$/.test(s.voice) ? s.voice : "",
    voiceSpeed: clamp(s.voiceSpeed, 0.7, 1.5, 1),
    hotkey: typeof s.hotkey === "string" ? s.hotkey.trim().slice(0, 40) : DEFAULT_SETTINGS.hotkey,
    voiceLock: s.voiceLock === true,
    voiceLockThreshold: clamp(s.voiceLockThreshold, 0.3, 0.9, 0.5),
    webcamPresence: s.webcamPresence === true,
    presenceLockMinutes: Math.round(clamp(s.presenceLockMinutes, 0, 120, 0)),
    screenTime: s.screenTime !== false,
    stockWatchlist: Array.isArray(s.stockWatchlist)
      ? s.stockWatchlist.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[\w.^=-]{1,20}$/.test(x)).slice(0, 15)
      : [],
    newsInBriefing: s.newsInBriefing !== false,
    billReminders: s.billReminders !== false,
  };
}

/** Merges a partial update (unknown keys ignored) and returns the result. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const known = Object.fromEntries(Object.entries(patch).filter(([k]) => k in DEFAULT_SETTINGS));
  const next = sanitize({ ...current, ...known } as Settings);
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}
