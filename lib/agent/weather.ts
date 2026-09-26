// Live weather from Open-Meteo (https://open-meteo.com) — free, no API key.

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

interface ForecastResponse {
  current?: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    weather_code: number[];
  };
}

// WMO weather interpretation codes, as documented by Open-Meteo.
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorms",
  96: "thunderstorms with light hail",
  99: "thunderstorms with heavy hail",
};

export function describeWeatherCode(code: number): string {
  return WEATHER_CODES[code] ?? "unsettled weather";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather service error (${res.status}).`);
  return (await res.json()) as T;
}

export async function geocode(place: string): Promise<GeoResult> {
  // Open-Meteo's geocoder matches a place name only — "Pune, India" finds
  // nothing — so search the first part and use the rest to pick a match.
  const [name, ...qualifiers] = place.split(",").map((p) => p.trim()).filter(Boolean);
  const data = await getJson<{ results?: GeoResult[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`,
  );
  const results = data.results ?? [];
  if (results.length === 0) throw new Error(`Couldn't find a place called "${place}".`);
  const hint = qualifiers.join(" ").toLowerCase();
  const match = hint
    ? results.find((r) => `${r.admin1 ?? ""} ${r.country ?? ""}`.toLowerCase().includes(hint))
    : undefined;
  return match ?? results[0];
}

/** Current conditions plus today's and tomorrow's outlook. `location` falls
 *  back to ULTRON_HOME_LOCATION from .env.local. */
export async function getWeather(location?: string): Promise<string> {
  const place = location?.trim() || process.env.ULTRON_HOME_LOCATION?.trim();
  if (!place) {
    throw new Error("No location given and ULTRON_HOME_LOCATION isn't set — ask the user which city (and remember it).");
  }
  const geo = await geocode(place);
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    forecast_days: "2",
    timezone: "auto",
  });
  const f = await getJson<ForecastResponse>(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  const where = [geo.name, geo.admin1, geo.country].filter(Boolean).join(", ");
  const lines = [`Weather for ${where}:`];
  if (f.current) {
    const c = f.current;
    lines.push(
      `Now: ${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C), ${describeWeatherCode(c.weather_code)}, humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h.`,
    );
  }
  const d = f.daily;
  if (d) {
    ["Today", "Tomorrow"].forEach((label, i) => {
      if (d.time[i] === undefined) return;
      const rain = d.precipitation_probability_max[i];
      lines.push(
        `${label}: ${describeWeatherCode(d.weather_code[i])}, high ${Math.round(d.temperature_2m_max[i])}°C, low ${Math.round(d.temperature_2m_min[i])}°C${rain != null ? `, ${rain}% chance of rain` : ""}.`,
      );
    });
  }
  return lines.join("\n");
}

/** Hour of the first likely rain (≥60% chance) in the next few hours at the
 *  user's home location, or null. For proactive "take an umbrella" notices. */
export async function rainExpectedSoon(hoursAhead = 3, location = process.env.ULTRON_HOME_LOCATION): Promise<{ at: Date; chance: number } | null> {
  if (!location?.trim()) return null;
  const geo = await geocode(location);
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    hourly: "precipitation_probability",
    forecast_hours: String(hoursAhead + 1),
    timezone: "auto",
  });
  const f = await getJson<{ hourly?: { time: string[]; precipitation_probability: (number | null)[] } }>(
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
  );
  const h = f.hourly;
  if (!h) return null;
  for (let i = 0; i < h.time.length; i++) {
    const chance = h.precipitation_probability[i] ?? 0;
    // Open-Meteo returns local times without an offset; the hour is what matters.
    if (chance >= 60) return { at: new Date(h.time[i]), chance };
  }
  return null;
}
