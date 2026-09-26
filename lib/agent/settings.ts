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
