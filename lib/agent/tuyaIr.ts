import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tuyaApi, tuyaDevices } from "./tuya";

// IR blasters ("universal remotes") from Smart Life: a small box that
// copies your AC / fan / TV remotes. Each remote you added in the app is
// controlled here by name — "set the AC to 24", "fan speed up".

// Device categories Tuya uses for IR hubs.
const HUB_CATEGORIES = new Set(["qt", "wnykq", "hwktwkq"]);
const AC_CATEGORY = "5";

export interface IrRemote {
  hubId: string;
  remoteId: string;
  name: string;
  categoryId: string;
}

interface IrKey {
  key: string;
  key_id: number;
  key_name: string;
}

let remoteCache: { at: number; remotes: IrRemote[] } | null = null;
const keyCache = new Map<string, IrKey[]>();

/** Test hook. */
export function resetIrState(): void {
  remoteCache = null;
  keyCache.clear();
}

export async function irRemotes(fresh = false): Promise<IrRemote[]> {
  if (!fresh && remoteCache && Date.now() - remoteCache.at < 5 * 60_000) return remoteCache.remotes;
  const hubs = (await tuyaDevices(fresh)).filter((d) => HUB_CATEGORIES.has(d.category));
  const remotes: IrRemote[] = [];
  for (const hub of hubs) {
    const list = await tuyaApi<{ remote_id: string; remote_name: string; category_id: string | number }[]>(
      "GET",
      `/v1.0/infrareds/${encodeURIComponent(hub.id)}/remotes`,
    ).catch(() => []);
    for (const r of list ?? []) remotes.push({ hubId: hub.id, remoteId: r.remote_id, name: r.remote_name, categoryId: String(r.category_id) });
  }
  remoteCache = { at: Date.now(), remotes };
  return remotes;
}

export function describeRemote(r: IrRemote): string {
  return `ir:${r.remoteId} — ${r.name} (IR remote${r.categoryId === AC_CATEGORY ? ", air conditioner" : ""}) — use ir_remote`;
}

export async function listIrRemotes(query = ""): Promise<string[]> {
  const q = query.trim().toLowerCase();
  return (await irRemotes(true)).filter((r) => !q || r.name.toLowerCase().includes(q) || (q.includes("ac") && r.categoryId === AC_CATEGORY)).map(describeRemote);
}

export async function findRemote(ref: string): Promise<IrRemote> {
  const r = ref.trim().replace(/^ir:/i, "");
  const remotes = await irRemotes();
  const byId = remotes.find((x) => x.remoteId === r);
  if (byId) return byId;
  const q = r.toLowerCase();
  const matches = remotes.filter((x) => x.name.toLowerCase() === q);
  const loose = matches.length ? matches : remotes.filter((x) => x.name.toLowerCase().includes(q) || (/\b(ac|air ?con)/.test(q) && x.categoryId === AC_CATEGORY));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new Error(`"${ref}" could mean ${loose.map((x) => x.name).join(", ")} — which one?`);
  throw new Error(
    remotes.length ? `No IR remote called "${ref}". Remotes: ${remotes.map((x) => x.name).join(", ")}.` : "No IR blaster remotes found — add your remotes to the IR blaster in the Smart Life app first.",
  );
}

async function keysOf(r: IrRemote): Promise<IrKey[]> {
  const cached = keyCache.get(r.remoteId);
  if (cached) return cached;
  const res = await tuyaApi<{ key_list?: IrKey[] }>("GET", `/v1.0/infrareds/${encodeURIComponent(r.hubId)}/remotes/${encodeURIComponent(r.remoteId)}/keys`);
  const keys = res.key_list ?? [];
  keyCache.set(r.remoteId, keys);
  return keys;
}

// Words people say → the names Tuya's remote keys usually have.
const KEY_SYNONYMS: Record<string, string[]> = {
  on: ["power", "on", "power_on"],
  off: ["power", "off", "power_off"],
  toggle: ["power"],
  power: ["power"],
  "speed up": ["speed_up", "fan_speed_up", "speed+", "speed", "wind_speed"],
  faster: ["speed_up", "fan_speed_up", "speed+", "speed"],
  "speed down": ["speed_down", "fan_speed_down", "speed-", "speed"],
  slower: ["speed_down", "fan_speed_down", "speed-", "speed"],
  speed: ["speed", "wind_speed", "fan_speed"],
  swing: ["swing", "shake", "oscillate", "head"],
  oscillate: ["swing", "shake", "oscillate", "head"],
  timer: ["timer"],
  mode: ["mode", "wind_mode"],
  "volume up": ["volume_up", "vol+", "volume+"],
  "volume down": ["volume_down", "vol-", "volume-"],
  mute: ["mute"],
  "channel up": ["channel_up", "ch+"],
  "channel down": ["channel_down", "ch-"],
  light: ["light", "lamp"],
};

export function pickKey(keys: IrKey[], wanted: string): IrKey | null {
  const w = wanted.trim().toLowerCase().replace(/[_-]+/g, " ");
  const flat = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const candidates = [w, ...(KEY_SYNONYMS[w] ?? [])].map(flat);
  for (const c of candidates) {
    const exact = keys.find((k) => flat(k.key) === c || flat(k.key_name) === c);
    if (exact) return exact;
  }
  for (const c of candidates) {
    const partial = keys.find((k) => flat(k.key).includes(c) || flat(k.key_name).includes(c));
    if (partial) return partial;
  }
  return null;
}

// Air conditioners take a whole "scene" (power + mode + temperature + fan)
// at once; the last one sent is remembered so "make it 22" keeps the mode.
interface AcState {
  power: 0 | 1;
  mode: number; // 0 cool, 1 heat, 2 auto, 3 fan, 4 dry
  temp: number;
  wind: number; // 0 auto, 1 low, 2 medium, 3 high
}
const AC_MODES: Record<string, number> = { cool: 0, heat: 1, auto: 2, fan: 3, dry: 4 };
const AC_WIND: Record<string, number> = { auto: 0, low: 1, medium: 2, mid: 2, high: 3 };

function acStatePath(): string {
  return path.join(os.homedir(), ".ultron", "ir-ac.json");
}

async function loadAc(remoteId: string): Promise<AcState> {
  try {
    const all = JSON.parse(await fs.readFile(acStatePath(), "utf-8")) as Record<string, AcState>;
    if (all[remoteId]) return all[remoteId];
  } catch {
    // first use
  }
  return { power: 0, mode: 0, temp: 24, wind: 0 };
}

async function saveAc(remoteId: string, s: AcState): Promise<void> {
  let all: Record<string, AcState> = {};
  try {
    all = JSON.parse(await fs.readFile(acStatePath(), "utf-8"));
  } catch {
    // first use
  }
  all[remoteId] = s;
  await fs.mkdir(path.dirname(acStatePath()), { recursive: true });
  await fs.writeFile(acStatePath(), JSON.stringify(all), "utf-8");
}

export interface IrRequest {
  remote: string;
  /** Button / action: on, off, speed up, swing, volume up… */
  key?: string;
  /** AC only. */
  temperature?: number;
  mode?: string;
  fan_speed?: string;
}

export function nextAcState(prev: AcState, req: Omit<IrRequest, "remote">): AcState {
  const next = { ...prev };
  const key = req.key?.trim().toLowerCase();
  if (key === "off" || key === "power off" || key === "turn off") next.power = 0;
  else next.power = 1; // any change to an AC implies it should be on
  if (req.temperature !== undefined) {
    if (!Number.isFinite(req.temperature)) throw new Error("Temperature must be a number.");
    next.temp = Math.min(30, Math.max(16, Math.round(req.temperature)));
  }
  if (req.mode) {
    const m = AC_MODES[req.mode.trim().toLowerCase()];
    if (m === undefined) throw new Error(`AC mode should be one of ${Object.keys(AC_MODES).join(", ")}.`);
    next.mode = m;
  }
  if (req.fan_speed) {
    const w = AC_WIND[req.fan_speed.trim().toLowerCase()];
    if (w === undefined) throw new Error("AC fan speed should be auto, low, medium or high.");
    next.wind = w;
  }
  return next;
}

/** ir_remote tool. */
export async function irControl(req: IrRequest): Promise<string> {
  const r = await findRemote(req.remote);
  if (r.categoryId === AC_CATEGORY) {
    const next = nextAcState(await loadAc(r.remoteId), req);
    const body = { power: next.power, mode: next.mode, temp: next.temp, wind: next.wind };
    const base = `/infrareds/${encodeURIComponent(r.hubId)}/air-conditioners/${encodeURIComponent(r.remoteId)}/scenes/command`;
    await tuyaApi("POST", `/v2.0${base}`, undefined, body).catch(() => tuyaApi("POST", `/v1.0${base}`, undefined, body));
    await saveAc(r.remoteId, next);
    if (!next.power) return `${r.name} is off.`;
    const mode = Object.keys(AC_MODES).find((k) => AC_MODES[k] === next.mode);
    const wind = Object.keys(AC_WIND).find((k) => AC_WIND[k] === next.wind);
    return `${r.name}: on, ${mode}, ${next.temp}°C, fan ${wind}.`;
  }
  if (!req.key?.trim()) throw new Error(`Which button on the ${r.name} remote?`);
  const keys = await keysOf(r);
  const key = pickKey(keys, req.key);
  if (!key) throw new Error(`The ${r.name} remote has no "${req.key}" button. Buttons: ${keys.map((k) => k.key_name || k.key).join(", ")}.`);
  await tuyaApi("POST", `/v1.0/infrareds/${encodeURIComponent(r.hubId)}/remotes/${encodeURIComponent(r.remoteId)}/command`, undefined, { key: key.key });
  const note = /^(on|off)$/i.test(req.key.trim()) && /power/i.test(key.key) ? " (IR remotes can't tell whether it was on — say it again if it went the wrong way)" : "";
  return `Pressed ${key.key_name || key.key} on the ${r.name} remote${note}.`;
}
