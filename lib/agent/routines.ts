import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sunTimes } from "./sun";

// Routines: one phrase ("good night", "movie mode") runs several actions —
// lights off, TV off, PC to sleep. A routine can also run on a schedule
// ("every day at 23:30", "at sunset"), from the background loop.

export interface RoutineStep {
  tool: string;
  input: Record<string, unknown>;
}

export interface Schedule {
  /** "HH:MM" (24-hour), "sunrise" or "sunset". */
  at: string;
  /** Minutes after (or, negative, before) sunrise/sunset. */
  offsetMinutes?: number;
  /** 0 = Sunday … 6 = Saturday; empty/missing = every day. */
  days?: number[];
}

export interface Routine {
  id: string;
  name: string;
  steps: RoutineStep[];
  schedule?: Schedule;
  /** Say/notify when a scheduled run happens (off by default — a 2 AM "fan off" shouldn't wake anyone). */
  announce?: boolean;
  createdAt: string;
  lastScheduledRun?: string; // day key
}

/** Which tools exist and which run without asking — supplied by tools.ts
 *  (importing it here would be circular). */
export interface ToolPolicy {
  known: (name: string) => boolean;
  auto: (name: string) => boolean;
}

// Tools a routine may not contain: routines inside routines, and anything
// whose whole point is a live back-and-forth with the user.
const FORBIDDEN_STEPS = new Set(["save_routine", "run_routine", "delete_routine", "list_routines", "operate_computer", "look_at_screen"]);
const MAX_STEPS = 15;
const SCHEDULE_GRACE_MS = 15 * 60_000; // PC asleep at 23:30 → still run at 23:40, not at 9 AM
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function storePath(): string {
  return path.join(os.homedir(), ".ultron", "routines.json");
}

function readSync(): Routine[] {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function write(routines: Routine[]): Promise<void> {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(routines, null, 2), "utf-8");
}

let queue: Promise<unknown> = Promise.resolve();
function withRoutines<T>(fn: (r: Routine[]) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const routines = readSync();
    const out = await fn(routines);
    await write(routines);
    return out;
  });
  queue = next.catch(() => {});
  return next;
}

function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(routine|mode|scene)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function listRoutinesRaw(): Routine[] {
  return existsSync(storePath()) ? readSync() : [];
}

export function findRoutine(name: string, routines = listRoutinesRaw()): Routine | null {
  const q = norm(name);
  if (!q) return null;
  return routines.find((r) => norm(r.name) === q) ?? routines.find((r) => norm(r.name).includes(q) || q.includes(norm(r.name))) ?? null;
}

/** A routine needs the user's OK when any of its steps would on its own. */
export function routineNeedsConfirmation(name: string, policy: ToolPolicy): boolean {
  const r = findRoutine(name);
  return Boolean(r && r.steps.some((s) => !policy.auto(s.tool)));
}

/** Accepts "23:30", "11:30 pm", "sunset", "sunset+15"/"sunset-30". */
export function parseSchedule(input: { at?: unknown; offset_minutes?: unknown; days?: unknown }): Schedule {
  const raw = String(input.at ?? "").trim().toLowerCase();
  let at: string;
  let offset = Number(input.offset_minutes ?? 0) || 0;
  const sun = raw.match(/^(sunrise|sunset)\s*([+-]\s*\d+)?$/);
  if (sun) {
    at = sun[1];
    if (sun[2]) offset = Number(sun[2].replace(/\s/g, ""));
  } else {
    const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) throw new Error(`Schedule time should look like 23:30, 7:15 am or sunset (got "${input.at}").`);
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) throw new Error(`"${input.at}" isn't a valid time.`);
    at = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  let days: number[] | undefined;
  if (Array.isArray(input.days) && input.days.length) {
    const set = new Set<number>();
    for (const d of input.days) {
      const s = String(d).trim().toLowerCase();
      if (s === "weekdays") [1, 2, 3, 4, 5].forEach((x) => set.add(x));
      else if (s === "weekends") [0, 6].forEach((x) => set.add(x));
      else {
        const i = DAY_NAMES.indexOf(s.slice(0, 3));
        if (i < 0) throw new Error(`Unknown day "${d}".`);
        set.add(i);
      }
    }
    days = [...set].sort();
  }
  return { at, ...(offset ? { offsetMinutes: Math.max(-240, Math.min(240, Math.round(offset))) } : {}), ...(days && days.length < 7 ? { days } : {}) };
}

export function describeSchedule(s: Schedule): string {
  const when = s.at.includes(":")
    ? s.at
    : `${s.offsetMinutes ? `${Math.abs(s.offsetMinutes)} min ${s.offsetMinutes > 0 ? "after" : "before"} ` : ""}${s.at}`;
  const days = s.days?.length
    ? s.days.join(",") === "1,2,3,4,5"
      ? "weekdays"
      : s.days.join(",") === "0,6"
        ? "weekends"
        : s.days.map((d) => DAY_NAMES[d]).join(", ")
    : "every day";
  return `${when}, ${days}`;
}

function describe(r: Routine): string {
  const steps = r.steps.map((s) => `${s.tool}(${JSON.stringify(s.input)})`).join("; ");
  return `${r.name}${r.schedule ? ` [runs ${describeSchedule(r.schedule)}]` : ""}: ${steps}`;
}

/** save_routine tool. Replaces a routine with the same name. */
export async function saveRoutine(
  args: { name: unknown; steps: unknown; schedule?: unknown; announce?: unknown },
  policy: ToolPolicy,
): Promise<string> {
  const name = String(args.name ?? "").trim().slice(0, 60);
  if (!norm(name)) throw new Error("The routine needs a name.");
  if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error("A routine needs at least one step.");
  if (args.steps.length > MAX_STEPS) throw new Error(`A routine can have at most ${MAX_STEPS} steps.`);
  const steps: RoutineStep[] = args.steps.map((raw, i) => {
    const s = raw as { tool?: unknown; input?: unknown };
    const tool = String(s.tool ?? "");
    if (!policy.known(tool)) throw new Error(`Step ${i + 1}: there's no tool called "${tool}".`);
    if (FORBIDDEN_STEPS.has(tool)) throw new Error(`Step ${i + 1}: ${tool} can't be part of a routine.`);
    const input = s.input && typeof s.input === "object" && !Array.isArray(s.input) ? (s.input as Record<string, unknown>) : {};
    return { tool, input };
  });
  const schedule = args.schedule && typeof args.schedule === "object" ? parseSchedule(args.schedule as never) : undefined;
  if (schedule) {
    const asking = steps.filter((s) => !policy.auto(s.tool)).map((s) => s.tool);
    if (asking.length) {
      throw new Error(`A scheduled routine runs with nobody there to confirm, so it can't include ${[...new Set(asking)].join(", ")}.`);
    }
  }
  return withRoutines((routines) => {
    const existing = routines.findIndex((r) => norm(r.name) === norm(name));
    const routine: Routine = {
      id: existing >= 0 ? routines[existing].id : randomUUID(),
      name,
      steps,
      ...(schedule ? { schedule } : {}),
      ...(args.announce === true || args.announce === "true" ? { announce: true } : {}),
      createdAt: new Date().toISOString(),
    };
    if (existing >= 0) routines[existing] = routine;
    else routines.push(routine);
    const confirm = steps.some((s) => !policy.auto(s.tool)) ? " It will ask before running, because some steps need confirmation." : "";
    return `${existing >= 0 ? "Updated" : "Saved"} "${name}" — ${steps.length} step${steps.length === 1 ? "" : "s"}${schedule ? `, runs ${describeSchedule(schedule)}` : ""}.${confirm}`;
  });
}

export async function listRoutines(): Promise<string> {
  const routines = listRoutinesRaw();
  return routines.length ? routines.map(describe).join("\n") : "No routines yet.";
}

export async function deleteRoutine(nameOrId: string): Promise<string> {
  return withRoutines((routines) => {
    const r = routines.find((x) => x.id === nameOrId) ?? findRoutine(nameOrId, routines);
    if (!r) throw new Error(`No routine called "${nameOrId}".`);
    routines.splice(routines.indexOf(r), 1);
    return `Deleted the "${r.name}" routine.`;
  });
}

export type StepRunner = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

/** Runs every step in order; one failing step doesn't stop the rest. */
export async function runRoutineSteps(r: Routine, run: StepRunner): Promise<string> {
  const lines: string[] = [];
  let failed = 0;
  for (const step of r.steps) {
    try {
      const out = await run(step.tool, step.input);
      const text = typeof out === "string" ? out : (out as { text?: string })?.text ?? "done";
      lines.push(`✓ ${step.tool}: ${text.split("\n")[0].slice(0, 160)}`);
    } catch (err) {
      failed++;
      lines.push(`✗ ${step.tool}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const head = failed ? `Ran "${r.name}" — ${failed} of ${r.steps.length} steps failed.` : `Ran "${r.name}".`;
  return `${head}\n${lines.join("\n")}`;
}

export async function runRoutine(name: string, run: StepRunner): Promise<string> {
  const r = findRoutine(name);
  if (!r) {
    const names = listRoutinesRaw().map((x) => x.name);
    throw new Error(`No routine called "${name}".${names.length ? ` Routines: ${names.join(", ")}.` : ""}`);
  }
  return runRoutineSteps(r, run);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** When a schedule fires on `now`'s day, or null (wrong weekday, no location for sunset…). */
export function scheduledTime(s: Schedule, now: Date, coords: { latitude: number; longitude: number } | null): Date | null {
  if (s.days?.length && !s.days.includes(now.getDay())) return null;
  if (s.at === "sunrise" || s.at === "sunset") {
    if (!coords) return null;
    const t = sunTimes(now, coords.latitude, coords.longitude);
    if (!t) return null;
    return new Date(t[s.at].getTime() + (s.offsetMinutes ?? 0) * 60_000);
  }
  const [h, m] = s.at.split(":").map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
}

/** Routines whose scheduled time has just passed and haven't run today;
 *  marks them as run. */
export async function takeDueRoutines(now: Date, coords: { latitude: number; longitude: number } | null): Promise<Routine[]> {
  if (!existsSync(storePath())) return [];
  return withRoutines((routines) => {
    const due: Routine[] = [];
    for (const r of routines) {
      if (!r.schedule || r.lastScheduledRun === dayKey(now)) continue;
      const at = scheduledTime(r.schedule, now, coords);
      if (!at) continue;
      const late = now.getTime() - at.getTime();
      if (late >= 0 && late <= SCHEDULE_GRACE_MS) {
        r.lastScheduledRun = dayKey(now);
        due.push({ ...r });
      }
    }
    return due;
  });
}

/** For the system prompt, so "good night" maps straight to its routine. */
export function routineNamesForPrompt(): string[] {
  return listRoutinesRaw().map((r) => r.name);
}
