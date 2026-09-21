import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".ultron");
const LOG_PATH = path.join(CONFIG_DIR, "fitness.json");

interface FitnessEntry {
  type: "workout" | "meal";
  description: string;
  value?: number; // minutes for a workout, calories for a meal
  notes?: string;
  loggedAt: string;
}

async function readLog(): Promise<FitnessEntry[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeLog(entries: FitnessEntry[]): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

export async function logWorkout(description: string, durationMin?: number, notes?: string): Promise<string> {
  const entries = await readLog();
  entries.push({ type: "workout", description, value: durationMin, notes, loggedAt: new Date().toISOString() });
  await writeLog(entries);
  return `Logged workout: ${description}${durationMin ? ` (${durationMin} min)` : ""}.`;
}

export async function logMeal(description: string, calories?: number, notes?: string): Promise<string> {
  const entries = await readLog();
  entries.push({ type: "meal", description, value: calories, notes, loggedAt: new Date().toISOString() });
  await writeLog(entries);
  return `Logged meal: ${description}${calories ? ` (${calories} kcal)` : ""}.`;
}

export async function fitnessSummary(days = 7): Promise<string> {
  const entries = await readLog();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => new Date(e.loggedAt).getTime() >= cutoff);
  if (recent.length === 0) return `No workouts or meals logged in the last ${days} days.`;

  const workouts = recent.filter((e) => e.type === "workout");
  const meals = recent.filter((e) => e.type === "meal");
  const totalMin = workouts.reduce((s, w) => s + (w.value ?? 0), 0);
  const totalCal = meals.reduce((s, m) => s + (m.value ?? 0), 0);
  return `Last ${days} days: ${workouts.length} workout(s) totaling ${totalMin} min; ${meals.length} meal(s) logged totaling ${totalCal} kcal.`;
}

export function calculateBmi(heightCm: number, weightKg: number): string {
  if (heightCm <= 0 || weightKg <= 0) throw new Error("height and weight must be positive.");
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  let category: string;
  if (bmi < 18.5) category = "underweight";
  else if (bmi < 25) category = "normal";
  else if (bmi < 30) category = "overweight";
  else category = "obese";
  return `BMI: ${bmi.toFixed(1)} (${category}). General estimate only, not medical advice.`;
}

const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  "very active": 1.9,
};

export function calculateCalorieTarget(
  sex: "male" | "female",
  ageYears: number,
  heightCm: number,
  weightKg: number,
  activityLevel: string,
): string {
  if (ageYears <= 0 || heightCm <= 0 || weightKg <= 0) throw new Error("age, height, and weight must be positive.");
  // Mifflin-St Jeor equation
  const bmr =
    sex === "male" ? 10 * weightKg + 6.25 * heightCm - 5 * ageYears + 5 : 10 * weightKg + 6.25 * heightCm - 5 * ageYears - 161;
  const mult = ACTIVITY_MULTIPLIERS[activityLevel.trim().toLowerCase()] ?? 1.375;
  const maintenance = bmr * mult;
  return (
    `Estimated BMR: ${Math.round(bmr)} kcal/day. Maintenance calories (${activityLevel}): ~${Math.round(maintenance)} kcal/day. ` +
    `Common targets: ~500 kcal/day below maintenance for gradual weight loss, ~300-500 above for gain. ` +
    `General estimate based on standard formulas, not medical advice — consult a professional for personalized guidance.`
  );
}
