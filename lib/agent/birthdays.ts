import { getAccessToken } from "./googleAuth";
import { jsonStore, localDay } from "./jsonStore";

// Birthdays from Google Contacts, plus any the user tells ULTRON about.
// Each morning: whose birthday is today (ULTRON offers to send a WhatsApp
// wish, which the user approves) and whose is tomorrow.

export interface Birthday {
  name: string;
  /** MM-DD */
  day: string;
  year?: number;
  source: "contacts" | "manual";
}

interface Store {
  manual: Birthday[];
  contacts: Birthday[];
  contactsFetched?: string;
  lastMorning?: string;
}
const store = jsonStore<Store>("birthdays.json", () => ({ manual: [], contacts: [] }));

interface Person {
  names?: { displayName?: string }[];
  birthdays?: { date?: { year?: number; month?: number; day?: number } }[];
}

async function fetchContactBirthdays(): Promise<Birthday[]> {
  const token = await getAccessToken();
  const out: Birthday[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ personFields: "names,birthdays", pageSize: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://people.googleapis.com/v1/people/me/connections?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google Contacts request failed (${res.status}).`);
    const data = (await res.json()) as { connections?: Person[]; nextPageToken?: string };
    for (const p of data.connections ?? []) {
      const name = p.names?.[0]?.displayName?.trim();
      const d = p.birthdays?.find((b) => b.date?.month && b.date?.day)?.date;
      if (name && d?.month && d.day) out.push({ name, day: `${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`, ...(d.year ? { year: d.year } : {}), source: "contacts" });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export interface BirthdayDeps {
  contacts: () => Promise<Birthday[]>;
}
export const defaultBirthdayDeps: BirthdayDeps = {
  contacts: () => (process.env.GOOGLE_CLIENT_ID ? fetchContactBirthdays() : Promise.resolve([])),
};

/** All birthdays, refreshing the Google Contacts copy once a day. */
async function all(now: Date, deps: BirthdayDeps): Promise<Birthday[]> {
  let s = await store.read();
  if (s.contactsFetched !== localDay(now)) {
    try {
      const contacts = await deps.contacts();
      await store.update((x) => {
        x.contacts = contacts;
        x.contactsFetched = localDay(now);
      });
      s = await store.read();
    } catch {
      // not connected / offline — use what we have
    }
  }
  // A manual entry for the same person wins.
  const manualNames = new Set(s.manual.map((b) => b.name.toLowerCase()));
  return [...s.manual, ...s.contacts.filter((b) => !manualNames.has(b.name.toLowerCase()))];
}

/** Days from `now` until the next time `mmdd` comes round (0 = today). */
export function daysUntil(mmdd: string, now = new Date()): number {
  const [m, d] = mmdd.split("-").map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), m - 1, d);
  // 29 Feb in a normal year: celebrate on 28 Feb.
  if (next.getMonth() !== m - 1) next = new Date(now.getFullYear(), 1, 28);
  if (next.getTime() < today.getTime()) {
    next = new Date(now.getFullYear() + 1, m - 1, d);
    if (next.getMonth() !== m - 1) next = new Date(now.getFullYear() + 1, 1, 28);
  }
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}

function turning(b: Birthday, now: Date): string {
  if (!b.year) return "";
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntil(b.day, now));
  const age = next.getFullYear() - b.year;
  return age > 0 && age < 120 ? ` (turning ${age})` : "";
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "12 March", "2001-03-12", "12/03", "03-12" → MM-DD (+year). Day-first for numbers. */
export function parseBirthday(input: string): { day: string; year?: number } {
  const s = input.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return { day: `${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, year: Number(m[1]) };
  if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(s))) return { day: `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`, ...(m[3] ? { year: Number(m[3]) } : {}) };
  const month = MONTHS.findIndex((mo) => new RegExp(`\\b${mo.slice(0, 3)}[a-z]*\\b`).test(s));
  const day = /\b([12]?\d|3[01])(?:st|nd|rd|th)?\b/.exec(s.replace(/\b\d{4}\b/, ""));
  const year = /\b(19|20)\d{2}\b/.exec(s)?.[0];
  if (month >= 0 && day) return { day: `${String(month + 1).padStart(2, "0")}-${day[1].padStart(2, "0")}`, ...(year ? { year: Number(year) } : {}) };
  throw new Error(`Couldn't read "${input}" as a date — say it like "12 March".`);
}

export async function addBirthday(name: string, date: string): Promise<string> {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error("Whose birthday?");
  const { day, year } = parseBirthday(date);
  const [mm, dd] = day.split("-").map(Number);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) throw new Error(`"${date}" isn't a real date.`);
  await store.update((s) => {
    s.manual = s.manual.filter((b) => b.name.toLowerCase() !== n.toLowerCase());
    s.manual.push({ name: n, day, ...(year ? { year } : {}), source: "manual" });
  });
  return `Saved ${n}'s birthday: ${new Date(2000, mm - 1, dd).toLocaleDateString("en-IN", { day: "numeric", month: "long" })}${year ? ` ${year}` : ""}.`;
}

export async function upcomingBirthdays(days = 30, now = new Date(), deps: BirthdayDeps = defaultBirthdayDeps): Promise<string> {
  const list = (await all(now, deps))
    .map((b) => ({ b, in: daysUntil(b.day, now) }))
    .filter((x) => x.in <= days)
    .sort((a, b) => a.in - b.in);
  if (!list.length) return `No birthdays in the next ${days} days${process.env.GOOGLE_CLIENT_ID ? "" : " (connect Google to include your contacts' birthdays)"}.`;
  return list
    .map(({ b, in: n }) => `${b.name}: ${n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days (${new Date(2000, Number(b.day.slice(0, 2)) - 1, Number(b.day.slice(3))).toLocaleDateString("en-IN", { day: "numeric", month: "short" })})`}${turning(b, now)}`)
    .join("\n");
}

/** Background, once each morning. */
export async function birthdayMorning(now = new Date(), deps: BirthdayDeps = defaultBirthdayDeps): Promise<string[]> {
  if (now.getHours() < 9) return [];
  const s = await store.read();
  if (s.lastMorning === localDay(now)) return [];
  await store.update((x) => void (x.lastMorning = localDay(now)));
  const list = await all(now, deps);
  const today = list.filter((b) => daysUntil(b.day, now) === 0);
  const tomorrow = list.filter((b) => daysUntil(b.day, now) === 1);
  const out: string[] = [];
  for (const b of today) out.push(`Sir, it's ${b.name}'s birthday today${turning(b, now)}. Shall I send a WhatsApp wish?`);
  if (tomorrow.length) out.push(`Sir, tomorrow is ${tomorrow.map((b) => `${b.name}'s`).join(" and ")} birthday.`);
  return out;
}
