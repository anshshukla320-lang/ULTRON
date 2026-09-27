import { eventsWithLocation } from "./calendarClient";
import { jsonStore } from "./jsonStore";

// "Leave now" alerts: for calendar events with a place, ULTRON works out the
// travel time from where the user is (the phone's last location, else home)
// and says when it's time to go. With GOOGLE_MAPS_API_KEY the time includes
// live traffic; without it, OpenStreetMap routing plus a traffic allowance.

const BUFFER_MIN = 10; // arrive a little early
const NO_TRAFFIC_FACTOR = 1.3;
const USER_AGENT = "ULTRON-assistant/1.0 (personal use)";

export interface Point {
  lat: number;
  lon: number;
}

interface Store {
  phone?: Point & { at: number; accuracy?: number };
  alerted: string[];
  cache: Record<string, { at: number; minutes: number; traffic: boolean }>;
}
const store = jsonStore<Store>("travel.json", () => ({ alerted: [], cache: {} }));

/** From the phone app: where it last was. */
export async function savePhoneLocation(lat: number, lon: number, accuracy?: number, at = Date.now()): Promise<void> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Bad location.");
  await store.update((s) => void (s.phone = { lat, lon, at, ...(accuracy !== undefined && Number.isFinite(accuracy) ? { accuracy } : {}) }));
}

/** Online meetings have a link or an app name as their "location". */
export function isPhysicalPlace(location: string): boolean {
  return !/https?:\/\/|\b(zoom|google meet|meet\.google|teams|webex|skype|online|virtual|call|phone)\b/i.test(location);
}

export interface TravelDeps {
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
}

const defaultDeps: TravelDeps = {
  fetchJson: async (url) => {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" } });
    if (!res.ok) throw new Error(`Map service error (${res.status}).`);
    return res.json();
  },
  now: () => Date.now(),
};

export async function geocodeAddress(q: string, deps: TravelDeps = defaultDeps): Promise<Point> {
  const r = (await deps.fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`)) as { lat: string; lon: string }[];
  if (!r?.[0]) throw new Error(`Couldn't find "${q}" on the map.`);
  return { lat: Number(r[0].lat), lon: Number(r[0].lon) };
}

/** Where the user is starting from, and how that was decided. */
export async function origin(deps: TravelDeps = defaultDeps): Promise<{ point: Point | string; label: string } | null> {
  const s = await store.read();
  if (s.phone && deps.now() - s.phone.at < 45 * 60_000) return { point: s.phone, label: "where your phone is" };
  const home = process.env.ULTRON_HOME_ADDRESS?.trim() || process.env.ULTRON_HOME_LOCATION?.trim();
  return home ? { point: home, label: "home" } : null;
}

/** Minutes to drive from `from` to `to`, and whether that includes live traffic. */
export async function travelMinutes(from: Point | string, to: string, deps: TravelDeps = defaultDeps): Promise<{ minutes: number; traffic: boolean }> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const mode = process.env.ULTRON_TRAVEL_MODE?.trim() || "driving";
  const fromText = typeof from === "string" ? from : `${from.lat},${from.lon}`;
  if (key) {
    const params = new URLSearchParams({ origins: fromText, destinations: to, mode, departure_time: "now", key });
    const r = (await deps.fetchJson(`https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`)) as {
      status: string;
      rows?: { elements?: { status: string; duration?: { value: number }; duration_in_traffic?: { value: number } }[] }[];
    };
    const el = r.rows?.[0]?.elements?.[0];
    if (r.status !== "OK" || el?.status !== "OK" || !el.duration) throw new Error(`Google Maps couldn't route to "${to}" (${el?.status ?? r.status}).`);
    return { minutes: Math.round((el.duration_in_traffic ?? el.duration).value / 60), traffic: !!el.duration_in_traffic };
  }
  const a = typeof from === "string" ? await geocodeAddress(from, deps) : from;
  const b = await geocodeAddress(to, deps);
  const profile = mode === "walking" ? "foot" : mode === "bicycling" ? "bike" : "driving";
  const r = (await deps.fetchJson(`https://router.project-osrm.org/route/v1/${profile}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`)) as {
    code: string;
    routes?: { duration: number }[];
  };
  if (r.code !== "Ok" || !r.routes?.[0]) throw new Error(`Couldn't find a route to "${to}".`);
  const factor = profile === "driving" ? NO_TRAFFIC_FACTOR : 1;
  return { minutes: Math.round((r.routes[0].duration / 60) * factor), traffic: false };
}

function describe(minutes: number, traffic: boolean): string {
  const t = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} minutes`;
  return `about ${t}${traffic ? " in current traffic" : ""}`;
}

/** travel_time tool. */
export async function travelTime(destination: string, from?: string, deps: TravelDeps = defaultDeps): Promise<string> {
  const o = from?.trim() ? { point: from.trim(), label: from.trim() } : await origin(deps);
  if (!o) throw new Error("I don't know where you're starting from — say where, or set ULTRON_HOME_ADDRESS in .env.local (the phone app also shares its location).");
  const { minutes, traffic } = await travelMinutes(o.point, destination, deps);
  return `${destination}: ${describe(minutes, traffic)} from ${o.label}${traffic || process.env.GOOGLE_MAPS_API_KEY ? "" : " (no live traffic data; set GOOGLE_MAPS_API_KEY for that)"}.`;
}

export interface LeaveDeps extends TravelDeps {
  events: (minutes: number) => Promise<{ id: string; summary: string; start: Date; location: string }[]>;
}

/** Background: returns the "time to leave" lines that are due now. */
export async function leaveNowCheck(deps: LeaveDeps = { ...defaultDeps, events: eventsWithLocation }): Promise<string[]> {
  const now = deps.now();
  const events = (await deps.events(4 * 60)).filter((e) => isPhysicalPlace(e.location));
  if (!events.length) return [];
  const o = await origin(deps);
  if (!o) return [];
  const s = await store.read();
  const out: string[] = [];
  for (const e of events) {
    const id = `${e.id}@${e.start.toISOString()}`;
    if (s.alerted.includes(id)) continue;
    // Re-check travel time at most every 15 minutes per event.
    let t = s.cache[id];
    if (!t || now - t.at > 15 * 60_000) {
      try {
        const r = await travelMinutes(o.point, e.location, deps);
        t = { at: now, ...r };
        await store.update((x) => void (x.cache[id] = t));
      } catch {
        continue; // can't route it — say nothing rather than something wrong
      }
    }
    if (t.minutes < 5) continue; // it's next door
    const leaveAt = e.start.getTime() - (t.minutes + BUFFER_MIN) * 60_000;
    if (now < leaveAt - 5 * 60_000 || now > e.start.getTime()) continue;
    const at = e.start.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
    const late = now > e.start.getTime() - t.minutes * 60_000;
    out.push(
      late
        ? `Sir, you should have left already for ${e.summary} at ${at} — it's ${describe(t.minutes, t.traffic)} from ${o.label}.`
        : `Sir, time to leave for ${e.summary} at ${at}: it's ${describe(t.minutes, t.traffic)} from ${o.label}.`,
    );
    await store.update((x) => {
      x.alerted = [...x.alerted, id].slice(-100);
      delete x.cache[id];
    });
  }
  return out;
}
