import { readEmail, searchEmailIds } from "./gmailClient";
import { claudeJson, emailsForPrompt } from "./claudeJson";
import { jsonStore, localDay } from "./jsonStore";

// Package tracking from order and shipping emails (Amazon, Flipkart, Myntra,
// couriers…). Each email is read once; the parcel's status only moves
// forward. ULTRON speaks up when something is out for delivery or delivered,
// and in the morning about anything expected that day.

const MODEL = "claude-haiku-4-5";
const SEARCH =
  'newer_than:12d (shipped OR dispatched OR "out for delivery" OR delivered OR "arriving" OR "on its way" OR "order confirmed" OR "order placed" OR "has been delivered" OR "will be delivered" OR "delivery attempt")';
const SCAN_EVERY_MS = 2 * 60 * 60_000;

export const STATUSES = ["ordered", "shipped", "out_for_delivery", "delivered", "cancelled", "returned"] as const;
export type Status = (typeof STATUSES)[number];

export interface Parcel {
  key: string;
  store: string;
  item: string;
  status: Status;
  expected: string; // YYYY-MM-DD or ""
  updatedAt: string;
}

interface Store {
  seen: string[];
  parcels: Parcel[];
  lastScanAt?: number;
  lastMorning?: string;
}
const store = jsonStore<Store>("packages.json", () => ({ seen: [], parcels: [] }));

export interface FoundUpdate {
  message_id: string;
  is_order_update: boolean;
  store: string;
  item: string;
  order_ref: string;
  status: Status;
  expected_date: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          is_order_update: { type: "boolean", description: "True only for a real order/shipment of the user's (not ads, not 'items you may like')." },
          store: { type: "string", description: "Amazon, Flipkart, Myntra, Blue Dart…" },
          item: { type: "string", description: "What it is, short: 'boAt earbuds', '2 books'." },
          order_ref: { type: "string", description: "Order or tracking number if given, else empty." },
          status: { type: "string", enum: [...STATUSES] },
          expected_date: { type: "string", description: "Expected delivery YYYY-MM-DD if stated, else empty." },
        },
        required: ["message_id", "is_order_update", "store", "item", "order_ref", "status", "expected_date"],
        additionalProperties: false,
      },
    },
  },
  required: ["updates"],
  additionalProperties: false,
} as const;

export interface PackageDeps {
  search: (q: string) => Promise<string[]>;
  read: (id: string) => Promise<string>;
  extract: (emails: { id: string; text: string }[], today: string) => Promise<FoundUpdate[]>;
}

export const defaultPackageDeps: PackageDeps = {
  search: (q) => searchEmailIds(q, 25),
  read: readEmail,
  extract: async (emails, today) =>
    (
      await claudeJson<{ updates: FoundUpdate[] }>({
        model: MODEL,
        system: `You read shopping and courier emails and list order/shipment updates. Today is ${today}. Never guess a date that isn't in the email; a weekday like "arriving Tuesday" means the next such day.`,
        content: emailsForPrompt(emails, 2500),
        schema: SCHEMA,
        usage: "email",
      })
    ).updates ?? [],
};

const RANK: Record<Status, number> = { ordered: 0, shipped: 1, out_for_delivery: 2, delivered: 3, cancelled: 3, returned: 4 };

function keyOf(u: Pick<FoundUpdate, "store" | "order_ref" | "item">): string {
  const s = u.store.trim().toLowerCase();
  return u.order_ref.trim() ? `${s}|${u.order_ref.trim().toLowerCase()}` : `${s}|${u.item.trim().toLowerCase()}`;
}

export function describeParcel(p: Parcel, now = new Date()): string {
  const status = p.status.replace(/_/g, " ");
  const when = p.expected && p.status !== "delivered" ? `, expected ${p.expected === localDay(now) ? "today" : new Date(`${p.expected}T12:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}` : "";
  return `${p.store}: ${p.item} — ${status}${when}`;
}

/** Reads new emails; returns the parcels whose status changed to something worth saying. */
export async function scanPackages(now = new Date(), deps: PackageDeps = defaultPackageDeps): Promise<Parcel[]> {
  const seen = new Set((await store.read()).seen);
  const ids = (await deps.search(SEARCH)).filter((id) => !seen.has(id));
  const emails = (await Promise.all(ids.map(async (id) => ({ id, text: await deps.read(id).catch(() => "") })))).filter((e) => e.text);
  const found = emails.length ? await deps.extract(emails, localDay(now)) : [];
  return store.update((s) => {
    s.seen = [...s.seen, ...ids].slice(-800);
    const changed: Parcel[] = [];
    for (const u of found) {
      if (!u.is_order_update || !ids.includes(u.message_id) || !STATUSES.includes(u.status) || !u.item.trim()) continue;
      const key = keyOf(u);
      const expected = /^\d{4}-\d{2}-\d{2}$/.test(u.expected_date) ? u.expected_date : "";
      const existing = s.parcels.find((p) => p.key === key);
      if (existing) {
        if (expected && existing.status !== "delivered") existing.expected = expected;
        if (RANK[u.status] < RANK[existing.status]) continue; // an older email read late
        if (u.status === existing.status) continue;
        existing.status = u.status;
        existing.updatedAt = now.toISOString();
        if (u.status === "out_for_delivery" || u.status === "delivered") changed.push({ ...existing });
      } else {
        const p: Parcel = { key, store: u.store.trim(), item: u.item.trim().slice(0, 80), status: u.status, expected, updatedAt: now.toISOString() };
        s.parcels.push(p);
        if (u.status === "out_for_delivery" || u.status === "delivered") changed.push({ ...p });
      }
    }
    // Finished parcels drop off after a week; stuck ones after a month.
    s.parcels = s.parcels.filter((p) => {
      const age = now.getTime() - new Date(p.updatedAt).getTime();
      return RANK[p.status] >= 3 ? age < 7 * 86_400_000 : age < 30 * 86_400_000;
    });
    return changed;
  });
}

export function announce(p: Parcel): string {
  return p.status === "delivered" ? `Sir, your ${p.store} parcel — ${p.item} — has been delivered.` : `Sir, your ${p.store} parcel — ${p.item} — is out for delivery.`;
}

/** Background: every couple of hours in the daytime, plus a morning "arriving today". */
export async function packageTick(now = new Date(), deps: PackageDeps = defaultPackageDeps): Promise<string[]> {
  const s = await store.read();
  const out: string[] = [];
  if (now.getHours() < 7 || now.getHours() >= 23) return out;
  if (!s.lastScanAt || now.getTime() - s.lastScanAt >= SCAN_EVERY_MS) {
    await store.update((x) => void (x.lastScanAt = now.getTime()));
    out.push(...(await scanPackages(now, deps)).map(announce));
  }
  if (now.getHours() >= 8 && s.lastMorning !== localDay(now)) {
    await store.update((x) => void (x.lastMorning = localDay(now)));
    const today = (await store.read()).parcels.filter((p) => p.expected === localDay(now) && RANK[p.status] < 2);
    if (today.length) out.push(`Sir, arriving today: ${today.map((p) => `${p.item} from ${p.store}`).join("; ")}.`);
  }
  return out;
}

/** track_packages tool. */
export async function trackPackages(now = new Date(), deps: PackageDeps = defaultPackageDeps): Promise<string> {
  await scanPackages(now, deps);
  await store.update((x) => void (x.lastScanAt = now.getTime()));
  const parcels = (await store.read()).parcels.sort((a, b) => RANK[a.status] - RANK[b.status] || a.expected.localeCompare(b.expected));
  return parcels.length ? parcels.map((p) => describeParcel(p, now)).join("\n") : "No orders or deliveries in the last couple of weeks of email.";
}

/** For the morning briefing. */
export async function packagesForBriefing(now = new Date()): Promise<string> {
  const active = (await store.read()).parcels.filter((p) => RANK[p.status] < 3);
  return active.length ? active.map((p) => describeParcel(p, now)).join("\n") : "No parcels on the way.";
}
