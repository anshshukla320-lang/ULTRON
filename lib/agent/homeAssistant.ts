// Smart-home control through Home Assistant's REST API
// (HOME_ASSISTANT_URL, e.g. http://homeassistant.local:8123, and a long-lived
// access token from your HA profile page in HOME_ASSISTANT_TOKEN).

interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string; device_class?: string };
}

// Doors, locks and alarms: never changed without the user confirming first.
const SECURITY_DOMAINS = new Set(["lock", "alarm_control_panel"]);
const SECURITY_COVER_CLASSES = new Set(["garage", "door", "gate"]);

function config(): { url: string; token: string } {
  const url = process.env.HOME_ASSISTANT_URL?.replace(/\/$/, "");
  const token = process.env.HOME_ASSISTANT_TOKEN;
  if (!url || !token) throw new Error("Home Assistant isn't set up — add HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN to .env.local.");
  return { url, token };
}

async function ha<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, token } = config();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Home Assistant error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

function describe(s: HaState): string {
  const a = s.attributes;
  const extras: string[] = [];
  if (typeof a.brightness === "number") extras.push(`brightness ${Math.round((a.brightness / 255) * 100)}%`);
  if (a.current_temperature !== undefined) extras.push(`at ${a.current_temperature}°`);
  if (a.temperature !== undefined) extras.push(`set to ${a.temperature}°`);
  return `${s.entity_id} — ${a.friendly_name ?? s.entity_id} — ${s.state}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

/** smart_home_devices tool. */
export async function listDevices(query = ""): Promise<string> {
  const q = query.trim().toLowerCase();
  const interesting = /^(light|switch|fan|climate|cover|lock|media_player|scene|script|vacuum|alarm_control_panel|input_boolean)\./;
  const states = (await ha<HaState[]>("/api/states")).filter(
    (s) => interesting.test(s.entity_id) && (!q || `${s.entity_id} ${s.attributes.friendly_name ?? ""}`.toLowerCase().includes(q)),
  );
  if (states.length === 0) return q ? `No devices match "${query}".` : "No controllable devices found.";
  return states.slice(0, 40).map(describe).join("\n");
}

export function isSecurityDevice(entityId: string, deviceClass?: string): boolean {
  const domain = entityId.split(".")[0];
  return SECURITY_DOMAINS.has(domain) || (domain === "cover" && SECURITY_COVER_CLASSES.has(deviceClass ?? ""));
}

/** Maps a friendly action onto Home Assistant's domain/service call. */
export function serviceFor(entityId: string, action: string): { domain: string; service: string } {
  const domain = entityId.split(".")[0];
  const a = action.trim().toLowerCase();
  const generic: Record<string, string> = { on: "turn_on", turn_on: "turn_on", off: "turn_off", turn_off: "turn_off", toggle: "toggle" };
  if (domain === "lock") return { domain, service: a === "unlock" || a === "open" ? "unlock" : "lock" };
  if (domain === "cover") return { domain, service: a === "close" || a === "off" ? "close_cover" : a === "stop" ? "stop_cover" : "open_cover" };
  if (domain === "scene" || domain === "script") return { domain, service: "turn_on" };
  if (domain === "vacuum") return { domain, service: a === "stop" || a === "dock" || a === "off" ? "return_to_base" : "start" };
  if (domain === "alarm_control_panel") return { domain, service: a === "disarm" || a === "off" ? "alarm_disarm" : "alarm_arm_away" };
  if (domain === "climate" && a === "set_temperature") return { domain, service: "set_temperature" };
  if (domain === "media_player" && ["play", "pause", "play_pause"].includes(a)) return { domain, service: `media_${a}` };
  const service = generic[a];
  if (!service) throw new Error(`Don't know how to "${action}" ${entityId}.`);
  return { domain, service };
}

async function call(entityId: string, action: string, opts: { brightness?: number; temperature?: number }): Promise<string> {
  const { domain, service } = serviceFor(entityId, action);
  const data: Record<string, unknown> = { entity_id: entityId };
  if (opts.brightness !== undefined && domain === "light") data.brightness_pct = Math.min(100, Math.max(0, Math.round(opts.brightness)));
  if (opts.temperature !== undefined && domain === "climate") data.temperature = opts.temperature;
  await ha(`/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) });
  const after = await ha<HaState>(`/api/states/${entityId}`).catch(() => null);
  return after ? `Done — ${describe(after)}` : `Done: ${domain}.${service} on ${entityId}.`;
}

/** smart_home_control tool — everyday devices, runs immediately. */
export async function controlDevice(entityId: string, action: string, brightness?: number, temperature?: number): Promise<string> {
  const state = await ha<HaState>(`/api/states/${entityId}`);
  if (isSecurityDevice(entityId, state.attributes.device_class)) {
    throw new Error(`${entityId} is a lock, alarm or door — use smart_home_security so the user confirms it first.`);
  }
  return call(entityId, action, { brightness, temperature });
}

/** smart_home_security tool — locks, alarms, garage/doors; needs confirmation. */
export async function controlSecurityDevice(entityId: string, action: string): Promise<string> {
  return call(entityId, action, {});
}
