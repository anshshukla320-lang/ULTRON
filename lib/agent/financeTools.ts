import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".ultron");
const LEDGER_PATH = path.join(CONFIG_DIR, "expenses.json");

interface ExpenseEntry {
  amount: number;
  category: string;
  note?: string;
  loggedAt: string;
}

async function readLedger(): Promise<ExpenseEntry[]> {
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

export async function logExpense(amount: number, category: string, note?: string): Promise<string> {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be a positive number.");
  const entries = await readLedger();
  entries.push({ amount, category: category.trim() || "uncategorized", note, loggedAt: new Date().toISOString() });
  await writeLedger(entries);
  return `Logged $${amount.toFixed(2)} under "${category}".`;
}

export async function expenseSummary(days = 30): Promise<string> {
  const entries = await readLedger();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => new Date(e.loggedAt).getTime() >= cutoff);
  if (recent.length === 0) return `No expenses logged in the last ${days} days.`;

  const byCategory = new Map<string, number>();
  let total = 0;
  for (const e of recent) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
    total += e.amount;
  }
  const lines = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([cat, sum]) => `${cat}: $${sum.toFixed(2)}`);
  return `Last ${days} days — total $${total.toFixed(2)} across ${recent.length} entries:\n${lines.join("\n")}`;
}

export function calculateLoan(principal: number, annualRatePct: number, years: number): string {
  if (principal <= 0 || years <= 0) throw new Error("principal and years must be positive.");
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
