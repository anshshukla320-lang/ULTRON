import { tuyaApi, tuyaConfigured, tuyaDevices, type TuyaDevice } from "./tuya";
import { jsonStore, localDay } from "./jsonStore";
import { money } from "./financeTools";
import { isAway } from "./security";

// Electricity use from Smart Life plugs that measure power (most do: the
// "cur_power" reading). Sampled every few minutes and added up per device
// per day, so "how much did the AC use this week?" has an answer — and
// ULTRON mentions anything drawing power while the user is out, or left
// running for many hours.

const SAMPLE_EVERY_MS = 5 * 60_000;
const MAX_GAP_MS = 20 * 60_000; // longer gaps (PC asleep) aren't guessed at
const ON_WATTS = 15;
const LONG_RUN_HOURS = 8;
const KEEP_DAYS = 62;
/** Things that are meant to stay on. */
const ALWAYS_ON = /fridge|refrigerator|router|wi-?fi|modem|freezer|aquarium|camera|cctv/i;

interface Sample {
  at: number;
  watts: number;
}

interface Store {
  /** day → deviceId → kWh */
  days: Record<string, Record<string, number>>;
  names: Record<string, string>;
  last: Record<string, Sample>;
  /** When each device started drawing power, for "left on" warnings. */
  onSince: Record<string, number>;
  warned: Record<string, number>;
  lastSampleAt?: number;
}
const store = jsonStore<Store>("energy.json", () => ({ days: {}, names: {}, last: {}, onSince: {}, warned: {} }));

const scaleCache = new Map<string, number>();
/** Tuya reports power as an integer with a decimal "scale" (usually 1: tenths of a watt). */
async function powerScale(id: string): Promise<number> {
  const cached = scaleCache.get(id);
  if (cached !== undefined) return cached;
  let scale = 1;
  try {
    const spec = await tuyaApi<{ status?: { code: string; values?: string }[] }>("GET", `/v1.0/iot-03/devices/${encodeURIComponent(id)}/specification`);
    const v = JSON.parse(spec.status?.find((s) => s.code === "cur_power")?.values ?? "{}") as { scale?: number };
    if (typeof v.scale === "number" && v.scale >= 0 && v.scale <= 3) scale = v.scale;
  } catch {
    // keep the usual scale
  }
  scaleCache.set(id, scale);
  return scale;
}

export interface Reading {
  id: string;
  name: string;
  watts: number;
}

export interface EnergyDeps {
  readings: () => Promise<Reading[]>;
  away: () => Promise<boolean>;
  now: () => number;
}

async function tuyaReadings(): Promise<Reading[]> {
  const devices: TuyaDevice[] = await tuyaDevices(true);
  const out: Reading[] = [];
  for (const d of devices) {
    const raw = d.status.find((s) => s.code === "cur_power")?.value;
    if (typeof raw !== "number" || !d.online) continue;
    out.push({ id: d.id, name: d.name, watts: raw / 10 ** (await powerScale(d.id)) });
  }
  return out;
}

export const defaultEnergyDeps: EnergyDeps = { readings: tuyaReadings, away: isAway, now: () => Date.now() };

/** Background: one sample of every plug; returns warnings to announce. */
export async function sampleEnergy(deps: EnergyDeps = defaultEnergyDeps): Promise<string[]> {
  const now = deps.now();
  const s0 = await store.read();
  if (s0.lastSampleAt && now - s0.lastSampleAt < SAMPLE_EVERY_MS - 10_000) return [];
  const readings = await deps.readings();
  const away = await deps.away();
  return store.update((s) => {
    s.lastSampleAt = now;
    const day = localDay(new Date(now));
    const out: string[] = [];
    for (const r of readings) {
      s.names[r.id] = r.name;
      const prev = s.last[r.id];
      if (prev && now - prev.at <= MAX_GAP_MS && now > prev.at) {
        // Trapezoid: average of the two readings over the gap.
        const kwh = (((prev.watts + r.watts) / 2) * ((now - prev.at) / 3_600_000)) / 1000;
        (s.days[day] ??= {})[r.id] = ((s.days[day] ?? {})[r.id] ?? 0) + kwh;
      }
      s.last[r.id] = { at: now, watts: r.watts };
      if (r.watts >= ON_WATTS) {
        s.onSince[r.id] ??= now;
        if (!ALWAYS_ON.test(r.name)) {
          const since = s.onSince[r.id];
          const warnedFor = s.warned[r.id];
          if (away && warnedFor !== since) {
            s.warned[r.id] = since;
            out.push(`Sir, the ${r.name} is still on (${Math.round(r.watts)} W) while you're out. Shall I switch it off?`);
          } else if (now - since >= LONG_RUN_HOURS * 3_600_000 && warnedFor !== since) {
            s.warned[r.id] = since;
            out.push(`Sir, the ${r.name} has been running for ${Math.round((now - since) / 3_600_000)} hours (${Math.round(r.watts)} W right now). Is that intended?`);
          }
        }
      } else {
        delete s.onSince[r.id];
      }
    }
    const cutoff = localDay(new Date(now - KEEP_DAYS * 86_400_000));
    for (const d of Object.keys(s.days)) if (d < cutoff) delete s.days[d];
    return out;
  });
}

function rate(): number {
  const r = Number(process.env.ULTRON_POWER_RATE);
  return Number.isFinite(r) && r > 0 ? r : 8; // ₹ per kWh, a typical Indian tariff
}

/** electricity_usage tool. */
export async function electricityUsage(period = "week", device = "", now = new Date(), deps: Pick<EnergyDeps, "readings"> = defaultEnergyDeps): Promise<string> {
  if (deps === defaultEnergyDeps && !tuyaConfigured()) throw new Error("Smart Life isn't connected (TUYA_ACCESS_ID / TUYA_ACCESS_SECRET).");
  const s = await store.read();
  const p = period.toLowerCase();
  const days = p === "today" ? 1 : p === "month" || p === "this_month" ? now.getDate() : p === "yesterday" ? 1 : 7;
  const end = p === "yesterday" ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) : now;
  const wanted = new Set<string>();
  for (let i = 0; i < days; i++) wanted.add(localDay(new Date(end.getFullYear(), end.getMonth(), end.getDate() - i)));
  const totals = new Map<string, number>();
  for (const [day, byDevice] of Object.entries(s.days)) {
    if (!wanted.has(day)) continue;
    for (const [id, kwh] of Object.entries(byDevice)) totals.set(id, (totals.get(id) ?? 0) + kwh);
  }
  const d = device.trim().toLowerCase();
  const rows = [...totals.entries()]
    .map(([id, kwh]) => ({ name: s.names[id] ?? id, kwh }))
    .filter((r) => !d || r.name.toLowerCase().includes(d))
    .sort((a, b) => b.kwh - a.kwh);
  const label = p === "today" ? "Today" : p === "yesterday" ? "Yesterday" : p.includes("month") ? "This month" : "Last 7 days";
  const now_ = await deps.readings().catch(() => [] as Reading[]);
  const live = now_.filter((r) => !d || r.name.toLowerCase().includes(d)).filter((r) => r.watts >= 1);
  const liveLine = live.length ? `\nRight now: ${live.map((r) => `${r.name} ${Math.round(r.watts)} W`).join(", ")}.` : "";
  if (!rows.length) {
    return `${label}: no power readings${d ? ` for "${device}"` : ""} yet — only plugs that measure power are counted, and the PC has to be on to sample them.${liveLine}`;
  }
  const total = rows.reduce((a, r) => a + r.kwh, 0);
  return `${label}${d ? "" : ` — ${total.toFixed(1)} kWh, about ${money(Math.round(total * rate()))}`}:\n${rows.map((r) => `${r.name}: ${r.kwh.toFixed(2)} kWh (~${money(Math.round(r.kwh * rate()))})`).join("\n")}${liveLine}\n(Counted while the PC is on; cost at ${money(rate())}/kWh — set ULTRON_POWER_RATE to change.)`;
}
