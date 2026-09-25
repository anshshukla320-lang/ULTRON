// Runs ULTRON's Windows-only tools for real on a Windows machine (used by
// the "windows-smoke" CI job; also safe to run by hand: `npx tsx
// scripts/windows-smoke.mts`). It never locks, sleeps, or shuts the PC
// down for real — the shutdown check is cancelled immediately.
import { execFileSync } from "node:child_process";
import { lookAtScreen } from "../lib/agent/screen";
import { setVolume, mediaControl, setBrightness, powerAction, cancelShutdown } from "../lib/agent/pcControls";
import { openApp, openWithShell, getSystemInfo } from "../lib/agent/systemActions";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanDiskJunk, cleanDiskJunk } from "../lib/agent/diskCleanup";
import { runCode } from "../lib/agent/codeRunner";
import { getWeather } from "../lib/agent/weather";

const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function processRunning(image: string): boolean {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], { encoding: "utf-8" });
  return out.toLowerCase().includes(image.toLowerCase());
}

await check("look_at_screen returns a real JPEG", async () => {
  const out = await lookAtScreen();
  if (typeof out === "string") throw new Error("no image returned");
  const bytes = Buffer.from(out.image.data, "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  if (bytes.length < 1000) throw new Error(`suspiciously small (${bytes.length} bytes)`);
  return `${out.text} ${Math.round(bytes.length / 1024)} KB`;
});

await check("set_volume up/down/set/mute", async () => {
  const r = [await setVolume("up", 10), await setVolume("down", 10), await setVolume("set", 40), await setVolume("toggle_mute"), await setVolume("toggle_mute")];
  return r.join(" ");
});

await check("media_control", async () => [await mediaControl("play_pause"), await mediaControl("play_pause")].join(" "));

await check("set_brightness (VMs have no brightness control — expect the friendly error)", async () => {
  try {
    return await setBrightness(50);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/doesn't let Windows change its brightness/.test(msg)) return `friendly error: ${msg}`;
    throw err;
  }
});

await check("open_app launches an app and it's really running", async () => {
  const msg = await openApp("notepad");
  for (let i = 0; i < 20 && !processRunning("notepad.exe"); i++) await sleep(500);
  const running = processRunning("notepad.exe");
  try {
    execFileSync("taskkill", ["/IM", "notepad.exe", "/F"], { stdio: "ignore" });
  } catch {
    // not running — reported below
  }
  if (!running) throw new Error(`"${msg}" but no notepad.exe process`);
  return msg;
});

await check("openWithShell passes a target containing & through intact", async () => {
  // Under the old `cmd /c start`, the "&" would have split this path and
  // run the rest as a command. Opening it with -PassThru proves the whole
  // path reached Windows.
  const dir = mkdtempSync(path.join(os.tmpdir(), "ultron-smoke-"));
  const file = path.join(dir, "a&b.cmd");
  writeFileSync(file, "@exit 0\r\n");
  const pid = await openWithShell(file, { app: true });
  if (!pid) throw new Error("no process started");
  return `started pid ${pid} for ${file}`;
});

await check("power_action shutdown, then cancel_shutdown", async () => {
  const none = await cancelShutdown();
  const scheduled = await powerAction("shutdown");
  const cancelled = await cancelShutdown();
  if (!/Cancelled/.test(cancelled)) throw new Error(`cancel failed: ${cancelled}`);
  return `${none} | ${scheduled} | ${cancelled}`;
});

await check("scan_disk_junk", async () => scanDiskJunk());
await check("clean_disk_junk", async () => cleanDiskJunk(["temp_files", "thumbnail_cache", "npm_cache", "recycle_bin"]));
await check("run_code powershell + node", async () => [await runCode("powershell", "Write-Output (2+2)"), await runCode("node", "console.log(6*7)")].join(" | "));
await check("get_system_info", async () => getSystemInfo());
await check("get_weather (live Open-Meteo)", async () => getWeather("Pune, India"));

for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail.replace(/\n/g, "\n      ")}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
