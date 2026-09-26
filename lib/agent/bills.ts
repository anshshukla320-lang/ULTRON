import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEmail, searchEmailIds } from "./gmailClient";
import { setReminder } from "./reminders";
import { recordUsage } from "./usage";

// Bills from Gmail: electricity, phone, broadband, credit-card statements.
// New bill emails are read by a small model that pulls out who, how much and
// when it's due; ULTRON then sets a reminder two days before. Each email is
// only ever looked at once.

const MODEL = "claude-haiku-4-5";
const SEARCH =
  'newer_than:45d (subject:(bill OR statement OR invoice OR "payment due" OR "due date" OR "amount due" OR recharge OR "e-bill") OR "total amount due" OR "minimum amount due" OR "bill amount")';
const REMIND_DAYS_BEFORE = 2;

export interface Bill {
  messageId: string;
  biller: string;
  amount: string;
  dueDate: string; // YYYY-MM-DD
}

interface Store {
  seen: string[];
  bills: Bill[];
  lastAutoScan?: string;
}

function storePath(): string {
  return path.join(os.homedir(), ".ultron", "bills.json");
}

async function readStore(): Promise<Store> {
  try {
    const s = JSON.parse(await fs.readFile(storePath(), "utf-8")) as Store;
    return { seen: s.seen ?? [], bills: s.bills ?? [], lastAutoScan: s.lastAutoScan };
  } catch {
    return { seen: [], bills: [] };
  }
}

async function writeStore(s: Store): Promise<void> {
  s.seen = s.seen.slice(-500);
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(s, null, 2), "utf-8");
}

const SCHEMA = {
  type: "object",
  properties: {
    bills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          is_bill_to_pay: { type: "boolean", description: "True only if this email asks the user to pay an amount by a date (not a receipt for something already paid, not marketing)." },
          biller: { type: "string", description: "Short name, e.g. 'Tata Power electricity', 'HDFC credit card', 'Airtel broadband'." },
          amount: { type: "string", description: "Amount with currency as written, e.g. '₹1,245.00'. Empty if not stated." },
          due_date: { type: "string", description: "Due date as YYYY-MM-DD, or empty if none is given." },
        },
        required: ["message_id", "is_bill_to_pay", "biller", "amount", "due_date"],
        additionalProperties: false,
      },
    },
  },
  required: ["bills"],
  additionalProperties: false,
} as const;

export interface BillDeps {
  search: (q: string) => Promise<string[]>;
  read: (id: string) => Promise<string>;
  extract: (emails: { id: string; text: string }[], today: string) => Promise<{ message_id: string; is_bill_to_pay: boolean; biller: string; amount: string; due_date: string }[]>;
  remind: (text: string, at: string) => Promise<unknown>;
}

async function extractWithClaude(emails: { id: string; text: string }[], today: string) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: `You read emails for a personal assistant and find bills the user still has to pay. Today is ${today}. Be exact; never guess amounts or dates that aren't in the email.`,
    messages: [
      {
        role: "user",
        content: emails.map((e) => `<email id="${e.id}">\n${e.text.slice(0, 3000)}\n</email>`).join("\n\n"),
      },
    ],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });
  void recordUsage("bills", MODEL, response.usage);
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
  return (JSON.parse(text) as { bills?: [] }).bills ?? [];
}

export const defaultBillDeps: BillDeps = {
  search: (q) => searchEmailIds(q, 20),
  read: readEmail,
  extract: extractWithClaude,
  remind: (text, at) => setReminder(text, at),
};

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Checks new bill emails; returns the new bills found (reminders already set). */
export async function scanBills(now = new Date(), deps: BillDeps = defaultBillDeps): Promise<Bill[]> {
  const store = await readStore();
  const ids = (await deps.search(SEARCH)).filter((id) => !store.seen.includes(id));
  if (!ids.length) return [];
  const emails = await Promise.all(ids.map(async (id) => ({ id, text: await deps.read(id).catch(() => "") })));
  const found = await deps.extract(emails.filter((e) => e.text), localDate(now));
  store.seen.push(...ids);
  const fresh: Bill[] = [];
  for (const b of found) {
    if (!b.is_bill_to_pay || !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date) || !ids.includes(b.message_id)) continue;
    const due = new Date(`${b.due_date}T10:00`);
    if (Number.isNaN(due.getTime()) || due.getTime() < now.getTime() - 86_400_000) continue; // already past
    // Same bill in two emails (bill + reminder email): keep one.
    const dup = store.bills.find((x) => x.biller.toLowerCase() === b.biller.toLowerCase() && x.dueDate === b.due_date);
    if (dup) continue;
    const bill: Bill = { messageId: b.message_id, biller: b.biller.trim(), amount: b.amount.trim(), dueDate: b.due_date };
    store.bills.push(bill);
    fresh.push(bill);
    let remindAt = new Date(due.getTime() - REMIND_DAYS_BEFORE * 86_400_000);
    if (remindAt.getTime() <= now.getTime()) remindAt = new Date(now.getTime() + 60 * 60_000); // due soon: remind in an hour
    const when = due.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
    await deps.remind(`your ${bill.biller} bill${bill.amount ? ` of ${bill.amount}` : ""} is due ${when}`, remindAt.toISOString()).catch(() => {});
  }
  store.bills = store.bills.filter((b) => new Date(`${b.dueDate}T23:59`).getTime() > now.getTime() - 30 * 86_400_000);
  await writeStore(store);
  return fresh;
}

export function describeBill(b: Bill): string {
  return `${b.biller}${b.amount ? ` — ${b.amount}` : ""}, due ${new Date(`${b.dueDate}T10:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
}

/** check_bills tool: scans for new bills and lists the upcoming ones. */
export async function checkBills(now = new Date(), deps: BillDeps = defaultBillDeps): Promise<string> {
  const fresh = await scanBills(now, deps);
  const upcoming = (await readStore()).bills
    .filter((b) => new Date(`${b.dueDate}T23:59`).getTime() >= now.getTime())
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (!upcoming.length) return "No unpaid bills found in the last 45 days of email.";
  return `${fresh.length ? `Found ${fresh.length} new bill${fresh.length === 1 ? "" : "s"} and set reminders ${REMIND_DAYS_BEFORE} days before each.\n` : ""}Upcoming bills:\n${upcoming.map(describeBill).join("\n")}`;
}

/** Once a day, from the background loop (after 9 AM, only if Gmail is connected). */
export async function dailyBillScan(now = new Date(), deps: BillDeps = defaultBillDeps): Promise<Bill[]> {
  if (now.getHours() < 9) return [];
  const store = await readStore();
  const today = localDate(now);
  if (store.lastAutoScan === today) return [];
  store.lastAutoScan = today;
  await writeStore(store);
  return scanBills(now, deps);
}
