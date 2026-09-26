import crypto from "node:crypto";

// Smart Life / Tuya devices (Wipro, Syska, Halonix, Havells and most other
// Wi-Fi bulbs and plugs sold in India) through Tuya's cloud API — the same
// cloud the Smart Life app talks to, so every device in the app shows up.
// Setup (once): a free "Cloud project" on iot.tuya.com, the Smart Life app
// linked to it by scanning a QR code, and its Access ID / Secret in
// TUYA_ACCESS_ID / TUYA_ACCESS_SECRET. Device ids are "tuya:<id>".

const REGIONS: Record<string, string> = {
  in: "https://openapi.tuyain.com",
  eu: "https://openapi.tuyaeu.com",
  weu: "https://openapi-weaz.tuyaeu.com",
  us: "https://openapi.tuyaus.com",
  eus: "https://openapi-ueaz.tuyaus.com",
  cn: "https://openapi.tuyacn.com",
  sg: "https://openapi-sg.iotbing.com",
};

// Locks, alarm panels, door/garage openers: never changed without the user
// confirming first (same rule as Home Assistant).
const SECURITY_CATEGORIES = new Set(["ms", "jtmspro", "jtmsbh", "videolock", "mk", "ckmkzq", "mal", "wf_ms", "bxx", "gyms"]);

const CATEGORY_NAMES: Record<string, string> = {
  dj: "light",
  dd: "light strip",
  xdd: "ceiling light",
  fwd: "light",
  dc: "light string",
  tgq: "dimmer",
  tgkg: "dimmer switch",
  cz: "plug",
  pc: "power strip",
  kg: "switch",
  fs: "fan",
  fsd: "ceiling fan light",
  kt: "air conditioner",
  infrared_ac: "air conditioner (IR remote)",
  wnykq: "IR remote",
  qn: "heater",
  cl: "curtain",
  ms: "lock",
  ckmkzq: "garage door",
  mal: "alarm",
};

export interface TuyaStatus {
  code: string;
  value: unknown;
}

export interface TuyaDevice {
  id: string;
  name: string;
  category: string;
  online: boolean;
  status: TuyaStatus[];
}

interface TuyaFunction {
  code: string;
  type: string;
  values: string;
}

interface Envelope<T> {
  success: boolean;
  result: T;
  code?: number;
  msg?: string;
}

function config(): { id: string; secret: string; base: string } {
  const id = process.env.TUYA_ACCESS_ID?.trim();
  const secret = process.env.TUYA_ACCESS_SECRET?.trim();
  if (!id || !secret) throw new Error("Smart Life isn't set up — add TUYA_ACCESS_ID and TUYA_ACCESS_SECRET to .env.local (see README).");
  const region = (process.env.TUYA_REGION ?? "in").trim().toLowerCase();
  const base = REGIONS[region] ?? (region.startsWith("https://") ? region.replace(/\/$/, "") : null);
  if (!base) throw new Error(`Unknown TUYA_REGION "${region}" — use one of ${Object.keys(REGIONS).join(", ")}.`);
  return { id, secret, base };
}

export function tuyaConfigured(): boolean {
  return Boolean(process.env.TUYA_ACCESS_ID && process.env.TUYA_ACCESS_SECRET);
}

/** Tuya's request signature: HMAC-SHA256 over the client id, token,
 *  timestamp and a canonical form of the request (sorted query, body hash). */
export function tuyaSign(p: {
  clientId: string;
  secret: string;
  accessToken: string;
  t: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: string;
}): { sign: string; url: string } {
  const q = p.query ?? {};
  const qs = Object.keys(q)
    .sort()
    .map((k) => `${k}=${q[k]}`)
    .join("&");
  const url = qs ? `${p.path}?${qs}` : p.path;
  const contentHash = crypto.createHash("sha256").update(p.body ?? "").digest("hex");
  const stringToSign = [p.method, contentHash, "", url].join("\n");
  const sign = crypto
    .createHmac("sha256", p.secret)
    .update(p.clientId + p.accessToken + p.t + stringToSign)
    .digest("hex")
    .toUpperCase();
  return { sign, url };
}

let token: { value: string; expiresAt: number } | null = null;

/** Test hook. */
export function resetTuyaState(): void {
  token = null;
  deviceCache = null;
  specCache.clear();
}

async function rawRequest<T>(method: string, path: string, query: Record<string, string> | undefined, bodyObj: unknown, accessToken: string): Promise<Envelope<T>> {
  const { id, secret, base } = config();
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const t = Date.now().toString();
  const { sign, url } = tuyaSign({ clientId: id, secret, accessToken, t, method, path, query, body });
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      client_id: id,
      sign,
      t,
      sign_method: "HMAC-SHA256",
      ...(accessToken ? { access_token: accessToken } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Smart Life cloud error (HTTP ${res.status}).`);
  return (await res.json()) as Envelope<T>;
}

function explain(e: Envelope<unknown>): Error {
  const hints: Record<number, string> = {
    1004: "the Access Secret looks wrong",
    1106: "this device isn't linked to your cloud project — link the Smart Life app under Devices > Link App Account",
    2009: "the device is offline",
    28841105: "the cloud project isn't allowed to use this — on iot.tuya.com, subscribe it to the IoT Core service",
    28841101: "the IoT Core trial has expired — extend it free on iot.tuya.com",
  };
  const hint = e.code !== undefined ? hints[e.code] : undefined;
  return new Error(`Smart Life said: ${e.msg ?? "unknown error"}${e.code ? ` (${e.code})` : ""}${hint ? ` — ${hint}.` : "."}`);
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const r = await rawRequest<{ access_token: string; expire_time: number }>("GET", "/v1.0/token", { grant_type: "1" }, undefined, "");
  if (!r.success) {
    if (r.code === 1004 || r.code === 1005) throw new Error("Smart Life rejected the Access ID / Secret — check TUYA_ACCESS_ID, TUYA_ACCESS_SECRET and TUYA_REGION.");
    throw explain(r);
  }
  token = { value: r.result.access_token, expiresAt: Date.now() + r.result.expire_time * 1000 };
  return token.value;
}

async function api<T>(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
  let r = await rawRequest<T>(method, path, query, body, await accessToken());
  if (!r.success && r.code === 1010) {
    token = null; // expired early — get a new one and retry once
    r = await rawRequest<T>(method, path, query, body, await accessToken());
  }
  if (!r.success) throw explain(r);
  return r.result;
}

let deviceCache: { at: number; devices: TuyaDevice[] } | null = null;

export async function tuyaDevices(fresh = false): Promise<TuyaDevice[]> {
  if (!fresh && deviceCache && Date.now() - deviceCache.at < 30_000) return deviceCache.devices;
  const devices: TuyaDevice[] = [];
  let lastRowKey = "";
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { size: "100", ...(lastRowKey ? { last_row_key: lastRowKey } : {}) };
    const r = await api<{ devices: TuyaDevice[]; has_more: boolean; last_row_key?: string }>("GET", "/v1.0/iot-01/associated-users/devices", query);
    devices.push(...(r.devices ?? []));
    if (!r.has_more || !r.last_row_key) break;
    lastRowKey = r.last_row_key;
  }
  deviceCache = { at: Date.now(), devices };
  return devices;
}

const specCache = new Map<string, TuyaFunction[]>();
async function functionsOf(id: string): Promise<TuyaFunction[]> {
  const cached = specCache.get(id);
  if (cached) return cached;
  const r = await api<{ functions?: TuyaFunction[] }>("GET", `/v1.0/iot-03/devices/${encodeURIComponent(id)}/specification`);
  const fns = r.functions ?? [];
  specCache.set(id, fns);
  return fns;
}

function range(fn: TuyaFunction | undefined, fallback: { min: number; max: number }): { min: number; max: number } {
  try {
    const v = JSON.parse(fn?.values ?? "{}") as { min?: number; max?: number };
    if (typeof v.min === "number" && typeof v.max === "number" && v.max > v.min) return { min: v.min, max: v.max };
  } catch {
    // malformed — use the usual range
  }
  return fallback;
}

/** 0-100 percent onto the device's own scale (Tuya v2 lights use 10-1000,
 *  older ones 25-255). */
export function scalePercent(pct: number, r: { min: number; max: number }): number {
  const p = Math.min(100, Math.max(0, pct)) / 100;
  return Math.round(r.min + p * (r.max - r.min));
}

const COLOR_HUES: Record<string, number> = {
  red: 0,
  orange: 30,
  amber: 40,
  yellow: 55,
  lime: 90,
  green: 120,
  teal: 170,
  cyan: 185,
  "sky blue": 200,
  blue: 230,
  indigo: 250,
  purple: 275,
  violet: 285,
  magenta: 300,
  pink: 320,
};

/** A spoken colour name or #rrggbb as hue/saturation (0-360, 0-1). */
export function parseColor(color: string): { h: number; s: number } | null {
  const c = color.trim().toLowerCase();
  if (c in COLOR_HUES) return { h: COLOR_HUES[c], s: 1 };
  const m = c.match(/^#?([0-9a-f]{6})$/);
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round((h * 60 + 360) % 360), s: max ? d / max : 0 };
}

const POWER_CODES = ["switch_led", "switch", "switch_1", "power", "switch_fan", "switch_2", "switch_3", "switch_4"];

function powerCode(d: TuyaDevice, channel?: number): string | null {
  if (channel !== undefined) {
    const code = `switch_${channel}`;
    if (!d.status.some((s) => s.code === code)) throw new Error(`${d.name} has no switch ${channel}.`);
    return code;
  }
  for (const code of POWER_CODES) if (d.status.some((s) => s.code === code && typeof s.value === "boolean")) return code;
  return null;
}

function statusValue(d: TuyaDevice, code: string): unknown {
  return d.status.find((s) => s.code === code)?.value;
}

export function isTuyaSecurityDevice(d: Pick<TuyaDevice, "category">): boolean {
  return SECURITY_CATEGORIES.has(d.category);
}

export function describeTuya(d: TuyaDevice): string {
  const kind = CATEGORY_NAMES[d.category] ?? d.category;
  const code = powerCode(d);
  const extras: string[] = [];
  const bright = statusValue(d, "bright_value_v2") ?? statusValue(d, "bright_value");
  if (typeof bright === "number") {
    const max = statusValue(d, "bright_value_v2") !== undefined ? 1000 : 255;
    extras.push(`brightness ${Math.round((bright / max) * 100)}%`);
  }
  const channels = d.status.filter((s) => /^switch_\d$/.test(s.code));
  if (channels.length > 1) extras.push(`${channels.length} switches: ${channels.map((s) => `${s.code.slice(7)} ${s.value ? "on" : "off"}`).join(", ")}`);
  const state = code ? (statusValue(d, code) ? "on" : "off") : "—";
  return `tuya:${d.id} — ${d.name} (${kind}) — ${d.online ? state : "OFFLINE"}${extras.length ? ` (${extras.join("; ")})` : ""}`;
}

/** Finds a device by "tuya:<id>", bare id, or (part of) its name. */
export async function findTuyaDevice(ref: string): Promise<TuyaDevice> {
  const r = ref.trim().replace(/^tuya:/i, "");
  let devices = await tuyaDevices();
  const byId = (list: TuyaDevice[]) => list.find((d) => d.id === r);
  let hit = byId(devices);
  if (!hit) {
    devices = await tuyaDevices(true);
    hit = byId(devices);
  }
  if (hit) return hit;
  const q = r.toLowerCase();
  const exact = devices.filter((d) => d.name.toLowerCase() === q);
  const partial = exact.length ? exact : devices.filter((d) => d.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${ref}" could mean ${partial.map((d) => d.name).join(", ")} — which one?`);
  throw new Error(`No Smart Life device called "${ref}". Devices: ${devices.map((d) => d.name).join(", ") || "none"}.`);
}

export async function listTuyaDevices(query = ""): Promise<string[]> {
  const q = query.trim().toLowerCase();
  return (await tuyaDevices(true))
    .filter((d) => !q || `${d.name} ${CATEGORY_NAMES[d.category] ?? d.category}`.toLowerCase().includes(q))
    .map(describeTuya);
}

export interface TuyaControl {
  action: string;
  brightness?: number;
  color?: string;
  warmth?: number; // 0 = warmest, 100 = coolest white
  channel?: number;
  speed?: number; // fans, 0-100
}

/** Turns a friendly request into Tuya commands for this device. */
export function buildTuyaCommands(d: TuyaDevice, fns: TuyaFunction[], c: TuyaControl): TuyaStatus[] {
  const has = (code: string) => fns.some((f) => f.code === code) || d.status.some((s) => s.code === code);
  const fn = (code: string) => fns.find((f) => f.code === code);
  const commands: TuyaStatus[] = [];
  const a = c.action.trim().toLowerCase().replace(/\s+/g, "_");
  const power = powerCode(d, c.channel);

  if (["on", "turn_on", "off", "turn_off", "toggle"].includes(a)) {
    if (!power) throw new Error(`${d.name} can't be switched on or off.`);
    const value = a === "toggle" ? !statusValue(d, power) : a === "on" || a === "turn_on";
    commands.push({ code: power, value });
  } else if (!["set", "adjust", "brightness", "color", "colour", "warmth", "speed", "set_brightness", "set_color"].includes(a)) {
    throw new Error(`Don't know how to "${c.action}" ${d.name} — try on, off, toggle, or set with brightness/color/warmth.`);
  }

  const brightCode = has("bright_value_v2") ? "bright_value_v2" : has("bright_value") ? "bright_value" : null;
  const tempCode = has("temp_value_v2") ? "temp_value_v2" : has("temp_value") ? "temp_value" : null;
  const colourCode = has("colour_data_v2") ? "colour_data_v2" : has("colour_data") ? "colour_data" : null;
  const turningOff = commands.some((x) => x.value === false);

  if (!turningOff && (c.brightness !== undefined || c.color !== undefined || c.warmth !== undefined || c.speed !== undefined)) {
    if (power && !commands.length) commands.push({ code: power, value: true }); // setting a colour implies "on"
  }

  if (c.color !== undefined && !turningOff) {
    const col = parseColor(c.color);
    if (!col) throw new Error(`Don't know the colour "${c.color}" — say a colour name or a hex code like #ff8800.`);
    if (!colourCode) throw new Error(`${d.name} can't change colour.`);
    const v2 = colourCode === "colour_data_v2";
    const brightPct = c.brightness ?? 100;
    const max = v2 ? 1000 : 255;
    commands.push({ code: "work_mode", value: "colour" });
    commands.push({
      code: colourCode,
      value: { h: col.h, s: Math.round(col.s * max), v: Math.max(v2 ? 10 : 25, Math.round((brightPct / 100) * max)) },
    });
  } else if (!turningOff && (c.brightness !== undefined || c.warmth !== undefined)) {
    if (has("work_mode") && (brightCode || tempCode)) commands.push({ code: "work_mode", value: "white" });
    if (c.brightness !== undefined) {
      if (!brightCode) throw new Error(`${d.name} can't be dimmed.`);
      const fallback = brightCode === "bright_value_v2" ? { min: 10, max: 1000 } : { min: 25, max: 255 };
      commands.push({ code: brightCode, value: scalePercent(c.brightness, range(fn(brightCode), fallback)) });
    }
    if (c.warmth !== undefined) {
      if (!tempCode) throw new Error(`${d.name} can't change its white temperature.`);
      const fallback = tempCode === "temp_value_v2" ? { min: 0, max: 1000 } : { min: 0, max: 255 };
      commands.push({ code: tempCode, value: scalePercent(c.warmth, range(fn(tempCode), fallback)) });
    }
  }

  if (c.speed !== undefined && !turningOff) {
    if (has("fan_speed_percent")) {
      commands.push({ code: "fan_speed_percent", value: scalePercent(c.speed, range(fn("fan_speed_percent"), { min: 1, max: 100 })) });
    } else if (has("fan_speed")) {
      const f = fn("fan_speed");
      if (f?.type === "Enum") {
        const levels = (JSON.parse(f.values || "{}") as { range?: string[] }).range ?? [];
        if (levels.length) commands.push({ code: "fan_speed", value: levels[Math.min(levels.length - 1, Math.floor((c.speed / 100) * levels.length))] });
      } else {
        commands.push({ code: "fan_speed", value: scalePercent(c.speed, range(f, { min: 1, max: 5 })) });
      }
    } else {
      throw new Error(`${d.name} has no speed setting.`);
    }
  }

  if (commands.length === 0) throw new Error(`Nothing to change on ${d.name}.`);
  return commands;
}

async function send(d: TuyaDevice, commands: TuyaStatus[]): Promise<string> {
  if (!d.online) throw new Error(`${d.name} is offline — check that it's powered and on Wi-Fi.`);
  await api("POST", `/v1.0/iot-03/devices/${encodeURIComponent(d.id)}/commands`, undefined, { commands });
  deviceCache = null;
  // Reflect the change locally rather than re-reading straight away — the
  // cloud can take a moment to report the device's new state.
  const after: TuyaDevice = {
    ...d,
    status: d.status.map((s) => commands.find((c) => c.code === s.code) ?? s),
  };
  return `Done — ${describeTuya(after)}`;
}

/** Everyday Smart Life devices — runs immediately. */
export async function controlTuya(ref: string, c: TuyaControl): Promise<string> {
  const d = await findTuyaDevice(ref);
  if (isTuyaSecurityDevice(d)) throw new Error(`${d.name} is a lock, alarm or door — use smart_home_security so the user confirms it first.`);
  const needsSpec = c.brightness !== undefined || c.warmth !== undefined || c.speed !== undefined || c.color !== undefined;
  const fns = needsSpec ? await functionsOf(d.id).catch(() => []) : [];
  return send(d, buildTuyaCommands(d, fns, c));
}

/** Locks / alarms / openers after the user confirmed. */
export async function controlTuyaSecurity(ref: string, action: string): Promise<string> {
  const d = await findTuyaDevice(ref);
  const fns = await functionsOf(d.id);
  const a = action.trim().toLowerCase();
  const bool = (code: string, v: boolean): TuyaStatus[] | null => (fns.some((f) => f.code === code) ? [{ code, value: v }] : null);
  const commands =
    (["open", "unlock"].includes(a) && (bool("switch_1", true) ?? bool("unlock_switch", true))) ||
    (["close", "lock"].includes(a) && (bool("switch_1", false) ?? bool("lock_switch", true))) ||
    (["arm", "on"].includes(a) && fns.some((f) => f.code === "master_mode") && [{ code: "master_mode", value: "arm" }]) ||
    (["disarm", "off"].includes(a) && fns.some((f) => f.code === "master_mode") && [{ code: "master_mode", value: "disarm" }]) ||
    null;
  if (!commands) throw new Error(`${d.name} can't "${action}" from the cloud — use the Smart Life app.`);
  return send(d, commands);
}
