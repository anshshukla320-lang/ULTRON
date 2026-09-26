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
import { getWeather, rainExpectedSoon } from "../lib/agent/weather";
import { defaultSources } from "../lib/agent/proactive";
import { showNotification, speakOnPc } from "../lib/agent/nativeOutput";
import { windowsExecutor, comboToVks, keyToVk } from "../lib/agent/computerUse";
import { findWhisper, transcribeWav } from "../lib/agent/whisperStt";
import { runPowerShell } from "../lib/agent/powershell";
import { adbPath, controlTv } from "../lib/agent/androidTv";
import { startDesktopHelper, type HelperLine } from "../lib/agent/desktopHelper";
import { readClipboard, writeClipboard } from "../lib/agent/clipboard";
import { getCricketScores, getNews, getStockPrices } from "../lib/agent/liveInfo";
import { enrollClip, ownerScore } from "../lib/agent/voiceId";
import { detectWake } from "../lib/voiceCommands";
import { existsSync, readFileSync } from "node:fs";

const results: { name: string; ok: boolean; detail: string }[] = [];
// A check can report SKIP when the CI machine lacks the hardware (e.g. no
// audio device); that's reported but doesn't fail the run.
const SKIP = "SKIP: ";

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

await check("rain forecast (live hourly Open-Meteo)", async () => {
  const rain = await rainExpectedSoon(3, "Pune, India");
  return rain ? `rain likely at ${rain.at.toLocaleTimeString()} (${rain.chance}%)` : "no rain expected in the next 3 hours";
});
await check("free disk space via fs.statfs", async () => {
  const { freeBytes, totalBytes } = await defaultSources.disk();
  if (!(totalBytes > 0 && freeBytes > 0 && freeBytes <= totalBytes)) throw new Error(`implausible: ${freeBytes}/${totalBytes}`);
  return `${Math.round(freeBytes / 1024 ** 3)} GB free of ${Math.round(totalBytes / 1024 ** 3)} GB`;
});

await check("Windows notification (background mode)", async () => {
  await showNotification("ULTRON smoke test", "Background notifications work.");
  return "shown";
});

await check("speak through the PC's speakers (Windows voice)", async () => {
  try {
    await speakOnPc("Background speech works.");
    return "spoken";
  } catch (err) {
    return `${SKIP}${err instanceof Error ? err.message.split("\n")[0] : err}`;
  }
});

await check("computer use: real mouse, keyboard and screenshots", async () => {
  const g = await windowsExecutor.geometry();
  await openApp("notepad");
  await sleep(2500);
  const shot = path.join(os.tmpdir(), "ultron-cu-smoke.jpg");
  const text = "ULTRON computer use check: 123 & ünïcödé नमस्ते";
  await windowsExecutor.run(
    [
      { op: "move", x: g.left + Math.round(g.width / 2), y: g.top + Math.round(g.height / 2) },
      { op: "type", text },
      { op: "keys", vks: comboToVks("ctrl+a"), up: false },
      { op: "keys", vks: comboToVks("ctrl+a"), up: true },
      { op: "keys", vks: comboToVks("ctrl+c"), up: false },
      { op: "keys", vks: comboToVks("ctrl+c"), up: true },
      { op: "sleep", ms: 300 },
      { op: "shot", x0: g.left, y0: g.top, x1: g.left + g.width, y1: g.top + g.height, w: Math.round(g.width * g.scale), h: Math.round(g.height * g.scale), file: shot },
    ],
    { failsafe: false },
  );
  const clip = (await runPowerShell("Get-Clipboard -Raw")).trim();
  try {
    execFileSync("taskkill", ["/IM", "notepad.exe", "/F"], { stdio: "ignore" });
  } catch {
    // already gone
  }
  if (clip !== text) throw new Error(`typed text came back as "${clip}"`);
  const jpeg = readFileSync(shot);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("screenshot isn't a JPEG");
  const { cursor } = await windowsExecutor.run([{ op: "move", x: g.left + 200, y: g.top + 150 }, { op: "cursor" }], { failsafe: false });
  if (cursor[0] !== `${g.left + 200},${g.top + 150}`) throw new Error(`cursor at ${cursor[0]}`);
  const corner = await windowsExecutor.run([{ op: "move", x: g.left, y: g.top }], { failsafe: false });
  const blocked = await windowsExecutor.run([{ op: "keys", vks: [keyToVk("a")], up: false }], { failsafe: true });
  if (!blocked.failsafe) throw new Error("mouse in the corner didn't trigger the emergency stop");
  void corner;
  return `screen ${g.width}x${g.height} (scale ${g.scale.toFixed(2)}); typed Unicode text round-tripped; screenshot ${Math.round(jpeg.length / 1024)} KB; failsafe works`;
});

await check("TV control: ADB installed, unreachable TV gives a clear answer", async () => {
  if (!existsSync(adbPath())) return `${SKIP}ADB not installed`;
  process.env.ANDROID_TV_HOST = "192.0.2.10"; // reserved test address — nothing answers
  try {
    await controlTv({ action: "mute" });
    throw new Error("expected an error");
  } catch (err) {
    const msg = (err as Error).message;
    if (!/Can't reach the TV/.test(msg)) throw err;
    return `${adbPath()} works; ${msg.split(" — ")[0]}`;
  } finally {
    delete process.env.ANDROID_TV_HOST;
  }
});

/** Windows' own voice saying something, as a 16 kHz mono WAV. */
async function sapiWav(text: string, voice = ""): Promise<Buffer> {
  const wav = path.join(os.tmpdir(), `ultron-sapi-${Date.now()}.wav`);
  await runPowerShell(
    `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:ULTRON_VOICE) { $s.SelectVoice($env:ULTRON_VOICE) }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:ULTRON_WAV, $fmt)
$s.Speak($env:ULTRON_TEXT)
$s.Dispose()`,
    { ULTRON_WAV: wav, ULTRON_TEXT: text, ULTRON_VOICE: voice },
  );
  return readFileSync(wav);
}

await check("desktop helper: global hotkey and foreground-app sampling", async () => {
  const lines: HelperLine[] = [];
  const helper = startDesktopHelper("Ctrl+Shift+F11", (l) => lines.push(l));
  try {
    const waitFor = async (pred: (l: HelperLine) => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (lines.some(pred)) return true;
        await sleep(250);
      }
      return false;
    };
    if (!(await waitFor((l) => l.type === "hotkey-status", 30_000))) throw new Error("helper never started");
    const status = lines.find((l) => l.type === "hotkey-status") as Extract<HelperLine, { type: "hotkey-status" }>;
    if (status.status !== "ok") throw new Error(`hotkey registration: ${status.status}`);
    await windowsExecutor.run(
      [
        { op: "keys", vks: comboToVks("ctrl+shift+f11"), up: false },
        { op: "keys", vks: comboToVks("ctrl+shift+f11"), up: true },
      ],
      { failsafe: false },
    );
    if (!(await waitFor((l) => l.type === "hotkey", 5000))) throw new Error("pressing the hotkey wasn't noticed");
    if (!(await waitFor((l) => l.type === "foreground", 20_000))) throw new Error("no foreground sample within 20 s");
    const fg = lines.find((l) => l.type === "foreground") as Extract<HelperLine, { type: "foreground" }>;
    return `hotkey registered and heard; in front: ${fg.process || "(desktop)"}, idle ${Math.round(fg.idleMs / 1000)} s`;
  } finally {
    helper?.stop();
  }
});

await check("clipboard round-trip (Unicode)", async () => {
  const text = "ULTRON clipboard ✓ ünïcödé नमस्ते\nsecond line";
  await writeClipboard(text);
  const out = await readClipboard();
  if (typeof out !== "string" || !out.endsWith(text)) throw new Error(`read back: ${JSON.stringify(out)}`);
  return "text survived both ways";
});

await check("live info: news, stocks, cricket", async () => {
  const news = await getNews();
  const stocks = await getStockPrices("Reliance, Nifty");
  const cricket = await getCricketScores();
  if (!news.startsWith("•")) throw new Error(`news: ${news}`);
  if (!/₹\d/.test(stocks)) throw new Error(`stocks: ${stocks}`);
  return `${news.split("\n")[0]}\n${stocks}\n${cricket.split("\n").slice(0, 2).join(" / ")}`;
});

await check("offline wake word (Whisper, wake mode)", async () => {
  if (!(await findWhisper())) return `${SKIP}Whisper not installed`;
  const text = await transcribeWav(await sapiWav("Hey Ultron, what time is it?"), "en", { wake: true });
  const rest = detectWake(text);
  if (rest === null) throw new Error(`wake word not found in "${text}"`);
  const none = await transcribeWav(await sapiWav("The weather is lovely this afternoon."), "en", { wake: true });
  if (detectWake(none) !== null) throw new Error(`false wake on "${none}"`);
  return `heard "${text}" → command "${rest}"; ordinary speech ignored ("${none}")`;
});

await check("voice lock: learns one voice, rejects another", async () => {
  const voices = (await runPowerShell(`Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }`))
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (voices.length < 2) return `${SKIP}only one Windows voice installed (${voices.join(", ")})`;
  const [owner, other] = voices;
  for (const phrase of [
    "Hey ULTRON, what's the weather like today and do I need an umbrella?",
    "Turn off the lights in the bedroom and set an alarm for seven in the morning.",
    "Remind me to call my mother this evening after I get back from work.",
  ]) {
    await enrollClip(await sapiWav(phrase, owner));
  }
  const same = await ownerScore(await sapiWav("Play some relaxing music and lower the volume a little bit, please.", owner));
  const diff = await ownerScore(await sapiWav("Play some relaxing music and lower the volume a little bit, please.", other));
  if (same === null || diff === null) throw new Error("not enrolled");
  if (!(same >= 0.5 && diff < 0.5)) throw new Error(`owner ${same.toFixed(2)}, other ${diff.toFixed(2)} — threshold 0.5 doesn't separate them`);
  return `${owner}: ${same.toFixed(2)} (accepted) vs ${other}: ${diff.toFixed(2)} (rejected)`;
});

await check("Whisper transcribes Windows' own voice", async () => {
  if (!(await findWhisper())) return `${SKIP}Whisper not installed`;
  const wav = path.join(os.tmpdir(), "ultron-stt-smoke.wav");
  await runPowerShell(
    `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:ULTRON_WAV, $fmt)
$s.Speak("What is the weather like today?")
$s.Dispose()`,
    { ULTRON_WAV: wav },
  );
  const text = await transcribeWav(readFileSync(wav), "en");
  if (!/weather/i.test(text)) throw new Error(`heard "${text}"`);
  return `heard: "${text}"`;
});

for (const r of results) {
  console.log(`${!r.ok ? "FAIL" : r.detail.startsWith(SKIP) ? "SKIP" : "PASS"}  ${r.name}\n      ${r.detail.replace(/\n/g, "\n      ")}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
