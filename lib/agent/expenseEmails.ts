import { readEmail, searchEmailIds } from "./gmailClient";
import { claudeJson, emailsForPrompt } from "./claudeJson";
import { readLedger, updateLedger, money, type ExpenseEntry } from "./financeTools";
import { jsonStore } from "./jsonStore";

// Automatic expense tracking: banks and UPI apps email a line for every card
// payment and UPI transfer. Those emails are read (each once) and the
// spending goes into the same ledger as expenses the user logs by voice.

const MODEL = "claude-haiku-4-5";
const SEARCH =
  'newer_than:4d (debited OR "debit alert" OR "transaction alert" OR "you have spent" OR "spent on your" OR "UPI" OR "txn" OR "paid to" OR "payment successful" OR "sent to")';
const SCAN_EVERY_MS = 3 * 60 * 60_000;

export const CATEGORIES = ["food", "groceries", "transport", "shopping", "bills", "entertainment", "health", "travel", "transfer", "other"] as const;

interface Store {
  seen: string[];
  lastScanAt?: number;
}
const store = jsonStore<Store>("expense-emails.json", () => ({ seen: [] }));

export interface FoundSpend {
  message_id: string;
  is_spend: boolean;
  amount: number;
  merchant: string;
  category: (typeof CATEGORIES)[number];
  date: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          is_spend: { type: "boolean", description: "True only for money that left the user's account/card (a purchase, bill payment or UPI payment). False for credits, refunds, OTPs, failed or declined payments, statements, offers." },
          amount: { type: "number", description: "Amount in the account's currency, as a number (1245.5)." },
          merchant: { type: "string", description: "Who was paid, short (Swiggy, Uber, 'Rahul Sharma')." },
          category: { type: "string", enum: [...CATEGORIES] },
          date: { type: "string", description: "Transaction date YYYY-MM-DD" },
        },
        required: ["message_id", "is_spend", "amount", "merchant", "category", "date"],
        additionalProperties: false,
      },
    },
  },
  required: ["transactions"],
  additionalProperties: false,
} as const;

export interface ExpenseScanDeps {
  search: (q: string) => Promise<string[]>;
  read: (id: string) => Promise<string>;
  extract: (emails: { id: string; text: string }[]) => Promise<FoundSpend[]>;
}

export const defaultExpenseScanDeps: ExpenseScanDeps = {
  search: (q) => searchEmailIds(q, 25),
  read: readEmail,
  extract: async (emails) =>
    (
      await claudeJson<{ transactions: FoundSpend[] }>({
        model: MODEL,
        system: "You read bank, card and UPI alert emails and list the payments the user made. Be exact; never guess an amount that isn't written.",
        content: emailsForPrompt(emails, 2000),
        schema: SCHEMA,
        usage: "email",
      })
    ).transactions ?? [],
};

/** Reads new transaction emails into the ledger. Returns what was added. */
export async function scanExpenseEmails(deps: ExpenseScanDeps = defaultExpenseScanDeps): Promise<ExpenseEntry[]> {
  const seen = new Set((await store.read()).seen);
  const ids = (await deps.search(SEARCH)).filter((id) => !seen.has(id));
  if (!ids.length) return [];
  const emails = (await Promise.all(ids.map(async (id) => ({ id, text: await deps.read(id).catch(() => "") })))).filter((e) => e.text);
  const found = emails.length ? await deps.extract(emails) : [];
  const added = await updateLedger((entries) => {
    const out: ExpenseEntry[] = [];
    for (const t of found) {
      if (!t.is_spend || !ids.includes(t.message_id) || !(t.amount > 0) || t.amount > 10_000_000) continue;
      if (entries.some((e) => e.ref === t.message_id)) continue;
      const day = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? new Date(`${t.date}T12:00`) : new Date();
      const entry: ExpenseEntry = {
        amount: Math.round(t.amount * 100) / 100,
        category: CATEGORIES.includes(t.category) ? t.category : "other",
        note: t.merchant.trim().slice(0, 60),
        loggedAt: (Number.isNaN(day.getTime()) ? new Date() : day).toISOString(),
        source: "email",
        ref: t.message_id,
      };
      entries.push(entry);
      out.push(entry);
    }
    return out;
  });
  await store.update((s) => {
    s.seen = [...s.seen, ...ids].slice(-800);
  });
  return added;
}

/** From the background loop: every few hours. */
export async function periodicExpenseScan(now = Date.now(), deps: ExpenseScanDeps = defaultExpenseScanDeps): Promise<ExpenseEntry[]> {
  const s = await store.read();
  if (s.lastScanAt && now - s.lastScanAt < SCAN_EVERY_MS) return [];
  await store.update((x) => void (x.lastScanAt = now));
  return scanExpenseEmails(deps);
}

/** scan_expenses tool: read new bank emails now and say what was found. */
export async function scanExpensesNow(deps: ExpenseScanDeps = defaultExpenseScanDeps): Promise<string> {
  const added = await scanExpenseEmails(deps);
  const total = (await readLedger()).filter((e) => e.source === "email").length;
  if (!added.length) return `No new payments in the bank emails (${total} logged from email so far).`;
  return `Logged ${added.length} new payment${added.length === 1 ? "" : "s"} from bank emails:\n${added.map((e) => `${money(e.amount)} — ${e.note} (${e.category})`).join("\n")}`;
}
