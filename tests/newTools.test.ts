import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getWeather, describeWeatherCode } from "../lib/agent/weather";
import { volumeKeySequence } from "../lib/agent/pcControls";
import { scanDiskJunk, cleanDiskJunk, categoryDirs, formatBytes } from "../lib/agent/diskCleanup";
import { buildSystemBlocks } from "../lib/agent/systemPrompt";

test("weather: geocodes with a country hint and formats the forecast", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    if (url.includes("geocoding")) {
      return Response.json({
        results: [
          { name: "Pune", latitude: 1, longitude: 2, country: "Somewhere Else" },
          { name: "Pune", latitude: 18.5, longitude: 73.8, admin1: "Maharashtra", country: "India" },
        ],
      });
    }
    return Response.json({
      current: { temperature_2m: 24.4, apparent_temperature: 26, relative_humidity_2m: 70, weather_code: 2, wind_speed_10m: 11 },
      daily: {
        time: ["2026-09-25", "2026-09-26"],
        temperature_2m_max: [29, 30],
        temperature_2m_min: [21, 22],
        precipitation_probability_max: [40, null],
        weather_code: [61, 3],
      },
    });
  });
  const out = await getWeather("Pune, India");
  assert.match(urls[0], /name=Pune&/, "only the city goes to the geocoder");
  assert.match(urls[1], /latitude=18\.5/, "picked the Indian Pune");
  assert.match(out, /Now: 24°C \(feels like 26°C\), partly cloudy/);
  assert.match(out, /Today: light rain, high 29°C, low 21°C, 40% chance of rain/);
  assert.match(out, /Tomorrow: overcast, high 30°C, low 22°C\.$/);
});

test("weather: needs a location", async () => {
  delete process.env.ULTRON_HOME_LOCATION;
  await assert.rejects(getWeather(), /ULTRON_HOME_LOCATION/);
  assert.equal(describeWeatherCode(12345), "unsettled weather");
});

test("volume key sequences", () => {
  assert.deepEqual(volumeKeySequence("up").keys, [[0xaf, 5]]);
  assert.deepEqual(volumeKeySequence("down", 30).keys, [[0xae, 15]]);
  assert.deepEqual(volumeKeySequence("set", 40).keys, [[0xae, 50], [0xaf, 20]]);
  assert.deepEqual(volumeKeySequence("set", 0).keys, [[0xae, 50]]);
  assert.throws(() => volumeKeySequence("set"), /0 to 100/);
  assert.throws(() => volumeKeySequence("louder"), /Unknown volume action/);
});

async function file(p: string, bytes: number, ageDays = 0) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  await fs.utimes(p, t, t);
}

test("disk cleanup deletes only safe files", async () => {
  const [tmp] = categoryDirs("temp_files");
  const [chrome] = categoryDirs("browser_cache");
  await file(path.join(tmp, "old.tmp"), 1000, 3);
  await file(path.join(tmp, "fresh.tmp"), 1000, 0);
  await file(path.join(chrome, "Default", "Cache", "Cache_Data", "f_0001"), 5000);
  await file(path.join(chrome, "Default", "Cookies"), 777);
  await file(path.join(chrome, "Default", "History"), 777);

  // On Windows temp_files also covers the real C:\\Windows\\Temp, so exact
  // totals only hold elsewhere; the safety checks below hold everywhere.
  const exact = process.platform !== "win32";
  const report = await scanDiskJunk();
  if (exact) assert.match(report, /temp_files: 1000 B/);
  assert.match(report, /browser_cache: 4\.9 KB/);

  const result = await cleanDiskJunk(["temp_files", "browser_cache"]);
  if (exact) assert.match(result, /Freed 5\.9 KB/);
  assert.match(result, /browser_cache: freed 4\.9 KB/);
  await assert.rejects(fs.access(path.join(tmp, "old.tmp")));
  await fs.access(path.join(tmp, "fresh.tmp")); // recent temp file kept
  await fs.access(path.join(chrome, "Default", "Cookies")); // never touched
  await fs.access(path.join(chrome, "Default", "History"));
  assert.equal(formatBytes(1536), "1.5 KB");
});

test("system prompt: static part cached, time in the uncached part", () => {
  const a = buildSystemBlocks("", new Date(2030, 0, 1, 9, 0));
  const b = buildSystemBlocks("likes tea", new Date(2030, 0, 2, 17, 45));
  assert.equal(a[0].text, b[0].text, "cached block identical across requests");
  assert.ok(a[0].cache_control);
  assert.ok(!a[1].cache_control);
  assert.match(b[1].text, /likes tea/);
  assert.match(b[1].text, /5:45/);
});
