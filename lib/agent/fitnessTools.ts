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
  if (!description.trim()) throw new Error("Describe the workout, e.g. '5k run'.");
  const entries = await readLog();
  entries.push({ type: "workout", description, value: durationMin, notes, loggedAt: new Date().toISOString() });
  await writeLog(entries);
  return `Logged workout: ${description}${durationMin ? ` (${durationMin} min)` : ""}.`;
}

export async function logMeal(description: string, calories?: number, notes?: string): Promise<string> {
  if (!description.trim()) throw new Error("Describe the meal.");
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

// Catches unit mix-ups (1.8 meaning metres, or pounds/inches) before they
// produce a confident-sounding nonsense number.
function checkBody(heightCm: number, weightKg: number): void {
  if (!Number.isFinite(heightCm) || !Number.isFinite(weightKg) || heightCm <= 0 || weightKg <= 0) {
    throw new Error("height and weight must be positive numbers.");
  }
  if (heightCm < 3) throw new Error(`Height ${heightCm} looks like metres — pass centimetres (e.g. ${Math.round(heightCm * 100)}).`);
  if (heightCm < 50 || heightCm > 272) throw new Error(`Height ${heightCm} cm is out of range — convert feet/inches to centimetres first.`);
  if (weightKg < 2 || weightKg > 650) throw new Error(`Weight ${weightKg} kg is out of range — convert pounds to kilograms first.`);
}

export function calculateBmi(heightCm: number, weightKg: number): string {
  checkBody(heightCm, weightKg);
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  // Each value can be in range on its own yet be inches/pounds together.
  if (bmi < 8 || bmi > 100) {
    throw new Error(`That gives a BMI of ${bmi.toFixed(0)}, which isn't humanly possible — check the units (centimetres and kilograms).`);
  }
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

function activityKey(level: string): string {
  const k = level.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    "lightly active": "light",
    "moderately active": "moderate",
    "extra active": "very active",
    "extremely active": "very active",
  };
  return aliases[k] ?? k;
}

export function calculateCalorieTarget(
  sex: "male" | "female",
  ageYears: number,
  heightCm: number,
  weightKg: number,
  activityLevel: string,
): string {
  if (!Number.isFinite(ageYears) || ageYears <= 0) throw new Error("age must be a positive number.");
  checkBody(heightCm, weightKg);
  const key = activityKey(activityLevel);
  const mult = ACTIVITY_MULTIPLIERS[key];
  if (mult === undefined) {
    throw new Error(`Unknown activity level "${activityLevel}". Use one of: ${Object.keys(ACTIVITY_MULTIPLIERS).join(", ")}.`);
  }
  // Mifflin-St Jeor equation
  const bmr =
    sex === "male" ? 10 * weightKg + 6.25 * heightCm - 5 * ageYears + 5 : 10 * weightKg + 6.25 * heightCm - 5 * ageYears - 161;
  const maintenance = bmr * mult;
  return (
    `Estimated BMR: ${Math.round(bmr)} kcal/day. Maintenance calories (${key}): ~${Math.round(maintenance)} kcal/day. ` +
    `Common targets: ~500 kcal/day below maintenance for gradual weight loss, ~300-500 above for gain. ` +
    `General estimate based on standard formulas, not medical advice — consult a professional for personalized guidance.`
  );
}
