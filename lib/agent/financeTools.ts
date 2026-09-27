import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".ultron");
const LEDGER_PATH = path.join(CONFIG_DIR, "expenses.json");

export interface ExpenseEntry {
  amount: number;
  category: string;
  note?: string;
  loggedAt: string;
  /** Where it came from: typed/said by the user, or read from a bank/UPI email. */
  source?: "manual" | "email";
  /** The Gmail message it was read from (so it's never logged twice). */
  ref?: string;
}

/** The user's currency symbol for spoken amounts (ULTRON_CURRENCY, default ₹). */
export function currency(): string {
  return process.env.ULTRON_CURRENCY?.trim() || "₹";
}

export function money(n: number): string {
  return `${currency()}${n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export async function readLedger(): Promise<ExpenseEntry[]> {
  try {
    const raw = await fs.readFile(LEDGER_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeLedger(entries: ExpenseEntry[]): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(LEDGER_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

let ledgerQueue: Promise<unknown> = Promise.resolve();
/** Serialized read-modify-write of the ledger. */
export function updateLedger<R>(fn: (entries: ExpenseEntry[]) => R): Promise<R> {
  const next = ledgerQueue.then(async () => {
    const entries = await readLedger();
    const r = fn(entries);
    await writeLedger(entries);
    return r;
  });
  ledgerQueue = next.catch(() => {});
  return next;
}

export async function logExpense(amount: number, category: string, note?: string): Promise<string> {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be a positive number.");
  const cat = category.trim().toLowerCase() || "uncategorized";
  await updateLedger((entries) => void entries.push({ amount, category: cat, note, loggedAt: new Date().toISOString(), source: "manual" }));
  return `Logged ${money(amount)} under "${cat}".`;
}

/** The window a summary covers: the last N days, or a calendar month. */
function window(period: string | number | undefined, now: Date): { from: number; to: number; label: string } {
  const p = typeof period === "string" ? period.trim().toLowerCase().replace(/\s+/g, "_") : period;
  if (p === "this_month" || p === "month") {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: now.getTime(), label: "This month" };
  }
  if (p === "last_month") {
    return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), to: new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1, label: "Last month" };
  }
  if (p === "today") return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), to: now.getTime(), label: "Today" };
  const days = Number(p) > 0 ? Math.min(Number(p), 366) : 30;
  return { from: now.getTime() - days * 86_400_000, to: now.getTime(), label: `Last ${days} days` };
}

export async function expenseSummary(period: string | number = 30, category?: string, now = new Date()): Promise<string> {
  const entries = await readLedger();
  const w = window(period, now);
  const cat = category?.trim().toLowerCase();
  const recent = entries.filter((e) => {
    const t = new Date(e.loggedAt).getTime();
    return t >= w.from && t <= w.to && (!cat || e.category.toLowerCase().includes(cat) || (e.note ?? "").toLowerCase().includes(cat));
  });
  if (recent.length === 0) return `${w.label}: no expenses${cat ? ` for "${cat}"` : ""}.`;

  const byCategory = new Map<string, number>();
  let total = 0;
  for (const e of recent) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
    total += e.amount;
  }
  const lines = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([c, sum]) => `${c}: ${money(sum)}`);
  const biggest = [...recent].sort((a, b) => b.amount - a.amount).slice(0, 3).map((e) => `${money(e.amount)} ${e.note ?? e.category}`);
  return `${w.label}${cat ? ` (${cat})` : ""} — total ${money(total)} across ${recent.length} entries:\n${lines.join("\n")}\nBiggest: ${biggest.join("; ")}`;
}

export function calculateLoan(principal: number, annualRatePct: number, years: number): string {
  if (![principal, annualRatePct, years].every(Number.isFinite)) throw new Error("principal, rate, and years must be numbers.");
  if (principal <= 0 || years <= 0) throw new Error("principal and years must be positive.");
  if (annualRatePct < 0) throw new Error("interest rate can't be negative.");
  const monthlyRate = annualRatePct / 100 / 12;
  const n = years * 12;
  const payment = monthlyRate === 0 ? principal / n : (principal * monthlyRate) / (1 - (1 + monthlyRate) ** -n);
  const totalPaid = payment * n;
  const totalInterest = totalPaid - principal;
  return `Monthly payment: $${payment.toFixed(2)}. Total paid over ${years} years: $${totalPaid.toFixed(2)}. Total interest: $${totalInterest.toFixed(2)}.`;
}

export async function convertCurrency(amount: number, from: string, to: string): Promise<string> {
  const fromCode = from.trim().toUpperCase();
  const toCode = to.trim().toUpperCase();
  const res = await fetch(`https://api.frankfurter.app/latest?amount=${amount}&from=${encodeURIComponent(fromCode)}&to=${encodeURIComponent(toCode)}`);
  if (!res.ok) {
    throw new Error(`Currency conversion failed (${res.status}). Check the currency codes are valid (e.g. USD, EUR, GBP, INR, JPY).`);
  }
  const data = (await res.json()) as { rates?: Record<string, number> };
  const converted = data.rates?.[toCode];
  if (converted === undefined) throw new Error(`No exchange rate found for "${toCode}".`);
  return `${amount} ${fromCode} = ${converted.toFixed(2)} ${toCode}`;
}
