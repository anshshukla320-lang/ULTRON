import { jsonStore, localDay, dailyDue } from "./jsonStore";

// Habits and goals: "I want to read 20 minutes a day". The user (or ULTRON,
// when told "done") ticks days off; streaks are counted, there's a gentle
// check-in each evening for anything not done yet, and a weekly review on
// Sundays.

export interface Habit {
  name: string;
  goal: string;
  createdAt: string;
  done: string[]; // YYYY-MM-DD
}

interface Store {
  habits: Habit[];
  lastCheckin?: string;
}
const store = jsonStore<Store>("habits.json", () => ({ habits: [] }));

function find(habits: Habit[], name: string): Habit {
  const n = name.trim().toLowerCase();
  const hit = habits.find((h) => h.name.toLowerCase() === n) ?? habits.find((h) => h.name.toLowerCase().includes(n) || n.includes(h.name.toLowerCase()) || h.goal.toLowerCase().includes(n));
  if (!hit) throw new Error(`No habit called "${name}". Habits: ${habits.map((h) => h.name).join(", ") || "none yet"}.`);
  return hit;
}

function shift(day: string, by: number): string {
  const d = new Date(`${day}T12:00`);
  d.setDate(d.getDate() + by);
  return localDay(d);
}

/** Days in a row up to today (or up to yesterday, if today isn't done yet). */
export function streak(h: Habit, now = new Date()): number {
  const done = new Set(h.done);
  let day = localDay(now);
  if (!done.has(day)) day = shift(day, -1);
  let n = 0;
  while (done.has(day)) {
    n++;
    day = shift(day, -1);
  }
  return n;
}

export function bestStreak(h: Habit): number {
  const days = [...new Set(h.done)].sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && shift(days[i - 1], 1) === days[i] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

export async function addHabit(name: string, goal = "", now = new Date()): Promise<string> {
  const n = name.trim().slice(0, 40);
  if (!n) throw new Error("What should the habit be called?");
  return store.update((s) => {
    if (s.habits.some((h) => h.name.toLowerCase() === n.toLowerCase())) return `You're already tracking ${n}.`;
    if (s.habits.length >= 20) throw new Error("That's 20 habits already — remove one first.");
    s.habits.push({ name: n, goal: goal.trim().slice(0, 120) || n, createdAt: now.toISOString(), done: [] });
    return `Tracking "${n}"${goal ? ` (${goal})` : ""}. Tell me when you've done it each day; I'll check in in the evening.`;
  });
}

export async function markHabitDone(name: string, day = "today", now = new Date()): Promise<string> {
  const d = day === "yesterday" ? shift(localDay(now), -1) : /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDay(now);
  return store.update((s) => {
    const h = find(s.habits, name);
    if (!h.done.includes(d)) h.done.push(d);
    h.done = h.done.sort().slice(-400);
    const st = streak(h, now);
    return `Marked "${h.name}" done${d === localDay(now) ? "" : ` for ${d}`}. Streak: ${st} day${st === 1 ? "" : "s"}${st >= 3 && st === bestStreak(h) ? " — your best yet" : ""}.`;
  });
}

export async function removeHabit(name: string): Promise<string> {
  return store.update((s) => {
    const h = find(s.habits, name);
    s.habits = s.habits.filter((x) => x !== h);
    return `Stopped tracking "${h.name}".`;
  });
}

/** Monday of the week containing `now`. */
function weekStart(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d);
}

export async function habitStatus(now = new Date()): Promise<string> {
  const { habits } = await store.read();
  if (!habits.length) return "No habits being tracked. Say e.g. 'I want to read 20 minutes a day'.";
  const today = localDay(now);
  const monday = weekStart(now);
  return habits
    .map((h) => {
      const week = h.done.filter((d) => d >= monday && d <= today).length;
      return `${h.name} (${h.goal}): ${h.done.includes(today) ? "done today" : "not yet today"}, streak ${streak(h, now)}, ${week} day${week === 1 ? "" : "s"} this week, best streak ${bestStreak(h)}`;
    })
    .join("\n");
}

/** Sunday's weekly review. */
export function weeklyReview(habits: Habit[], now = new Date()): string {
  const monday = weekStart(now);
  const today = localDay(now);
  const lines = habits.map((h) => {
    const n = h.done.filter((d) => d >= monday && d <= today).length;
    return `${h.name} ${n} of 7`;
  });
  const perfect = habits.filter((h) => h.done.filter((d) => d >= monday && d <= today).length === 7).map((h) => h.name);
  return `Your week, sir: ${lines.join(", ")}.${perfect.length ? ` Every single day for ${perfect.join(" and ")} — well done.` : ""}`;
}

/** Background: the evening check-in (and on Sundays the weekly review). */
export async function habitCheckin(time: string, now = new Date()): Promise<string[]> {
  const s = await store.read();
  if (!s.habits.length || !time || !dailyDue(time, s.lastCheckin, now)) return [];
  await store.update((x) => void (x.lastCheckin = localDay(now)));
  const out: string[] = [];
  const today = localDay(now);
  const pending = s.habits.filter((h) => !h.done.includes(today));
  if (pending.length) {
    const goals = pending.map((h) => h.goal);
    out.push(`Sir, a quick check-in: did you ${goals.length === 1 ? goals[0] : `${goals.slice(0, -1).join(", ")} and ${goals.at(-1)}`} today? Tell me and I'll tick it off.`);
  }
  if (now.getDay() === 0) out.push(weeklyReview(s.habits, now));
  return out;
}

/** For the journal's day material. */
export async function habitsDoneOn(day: string): Promise<string[]> {
  return (await store.read()).habits.filter((h) => h.done.includes(day)).map((h) => h.name);
}
