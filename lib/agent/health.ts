import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Steps, sleep and heart rate from the phone (Health Connect), uploaded by
// the ULTRON app, so the PC can mention them in the morning briefing and
// answer "how did I sleep?".

export interface HealthDay {
  date: string; // YYYY-MM-DD, the phone's local day
  steps?: number;
  sleepMinutes?: number;
  restingHeartRate?: number;
  avgHeartRate?: number;
}

const KEEP_DAYS = 30;

function storePath(): string {
  return path.join(os.homedir(), ".ultron", "health.json");
}

export async function readHealth(): Promise<HealthDay[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(), "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined);

/** Merges uploaded days (newer values win) and returns how many were stored. */
export async function saveHealth(raw: unknown): Promise<number> {
  const incoming: HealthDay[] = (Array.isArray(raw) ? raw : [])
    .map((d) => d as Record<string, unknown>)
    .filter((d) => typeof d?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date as string))
    .map((d) => ({
      date: d.date as string,
      steps: num(d.steps, 200_000),
      sleepMinutes: num(d.sleepMinutes, 24 * 60),
      restingHeartRate: num(d.restingHeartRate, 250),
      avgHeartRate: num(d.avgHeartRate, 250),
    }));
  if (!incoming.length) return 0;
  const byDate = new Map((await readHealth()).map((d) => [d.date, d]));
  for (const d of incoming) byDate.set(d.date, { ...byDate.get(d.date), ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) } as HealthDay);
  const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-KEEP_DAYS);
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(all, null, 1), "utf-8");
  return incoming.length;
}

function hm(min: number): string {
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function describeDay(d: HealthDay): string {
  const parts: string[] = [];
  if (d.sleepMinutes !== undefined) parts.push(`slept ${hm(d.sleepMinutes)}`);
  if (d.steps !== undefined) parts.push(`${d.steps.toLocaleString("en-IN")} steps`);
  if (d.restingHeartRate !== undefined) parts.push(`resting heart rate ${d.restingHeartRate}`);
  else if (d.avgHeartRate !== undefined) parts.push(`average heart rate ${d.avgHeartRate}`);
  return `${d.date}: ${parts.join(", ") || "no data"}`;
}

/** health_summary tool: the last `days` days. */
export async function healthSummary(days = 7): Promise<string> {
  const all = (await readHealth()).slice(-Math.min(30, Math.max(1, days)));
  if (!all.length) return "No health data yet — it comes from the ULTRON phone app (Health Connect), once you allow it there.";
  const withSteps = all.filter((d) => d.steps !== undefined);
  const withSleep = all.filter((d) => d.sleepMinutes !== undefined);
  const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  const lines = all.map(describeDay);
  if (all.length > 1) {
    lines.push(
      `Averages: ${withSteps.length ? `${avg(withSteps.map((d) => d.steps!)).toLocaleString("en-IN")} steps` : ""}${withSteps.length && withSleep.length ? ", " : ""}${withSleep.length ? `${hm(avg(withSleep.map((d) => d.sleepMinutes!)))} sleep` : ""}.`,
    );
  }
  return lines.join("\n");
}

/** For the morning briefing: last night's sleep and yesterday's steps, if fresh. */
export async function healthForBriefing(now = new Date()): Promise<string> {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = iso(now);
  const yesterday = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const all = await readHealth();
  const recent = all.filter((d) => d.date === today || d.date === yesterday);
  if (!recent.length) return "No recent health data from the phone.";
  return recent.map(describeDay).join("\n");
}
