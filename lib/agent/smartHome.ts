import { controlDevice, controlSecurityDevice, haConfigured, listDevices } from "./homeAssistant";
import { controlTuya, controlTuyaSecurity, listTuyaDevices, tuyaConfigured } from "./tuya";
import { tvConfigured } from "./androidTv";

// One set of smart-home tools over every place devices can live: Smart Life
// (Tuya cloud) and Home Assistant. Device ids say which: "tuya:<id>" vs
// Home Assistant's "light.bedroom". A plain name ("bedroom light") is looked
// up in Smart Life.

const HA_ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

function isTuyaRef(ref: string): boolean {
  if (/^tuya:/i.test(ref)) return true;
  if (HA_ENTITY.test(ref.trim())) return false;
  return tuyaConfigured();
}

const NOT_SET_UP =
  "No smart-home connection is set up. For Smart Life / Tuya devices add TUYA_ACCESS_ID and TUYA_ACCESS_SECRET; for Home Assistant add HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN (.env.local, see README).";

/** smart_home_devices tool. */
export async function listSmartHome(query = ""): Promise<string> {
  if (!tuyaConfigured() && !haConfigured()) {
    if (tvConfigured()) return "The TV is set up (use tv_control). No lights or plugs are connected yet.";
    throw new Error(NOT_SET_UP);
  }
  const sections: string[] = [];
  const problems: string[] = [];
  if (tuyaConfigured()) {
    try {
      const lines = await listTuyaDevices(query);
      if (lines.length) sections.push(lines.join("\n"));
    } catch (err) {
      problems.push(`Smart Life: ${(err as Error).message}`);
    }
  }
  if (haConfigured()) {
    try {
      const out = await listDevices(query);
      if (!/^No (controllable )?devices/.test(out)) sections.push(out);
    } catch (err) {
      problems.push(`Home Assistant: ${(err as Error).message}`);
    }
  }
  if (tvConfigured() && (!query || /tv|tele/i.test(query))) sections.push("TV — Android TV — use tv_control");
  if (!sections.length && problems.length) throw new Error(problems.join("\n"));
  const body = sections.length ? sections.join("\n") : query ? `No devices match "${query}".` : "No controllable devices found.";
  return problems.length ? `${body}\n\n(${problems.join("; ")})` : body;
}

export interface SmartHomeRequest {
  device: string;
  action: string;
  brightness?: number;
  temperature?: number;
  color?: string;
  warmth?: number;
  speed?: number;
  channel?: number;
}

/** smart_home_control tool. */
export async function controlSmartHome(r: SmartHomeRequest): Promise<string> {
  if (!r.device.trim()) throw new Error("Which device?");
  if (isTuyaRef(r.device)) {
    return controlTuya(r.device, { action: r.action, brightness: r.brightness, color: r.color, warmth: r.warmth, channel: r.channel, speed: r.speed });
  }
  if (!haConfigured()) throw new Error(NOT_SET_UP);
  return controlDevice(r.device, r.action, r.brightness, r.temperature, { color: r.color, warmth: r.warmth });
}

/** smart_home_security tool (after the user confirmed). */
export async function controlSmartHomeSecurity(device: string, action: string): Promise<string> {
  if (isTuyaRef(device)) return controlTuyaSecurity(device, action);
  return controlSecurityDevice(device, action);
}
