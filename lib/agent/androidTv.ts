import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Android TV / Google TV (Sony, Mi, TCL, OnePlus, Hisense, Vu...) over the
// home Wi-Fi, using ADB — Android's own debugging bridge. Setup (once):
// scripts\install-adb.ps1, then on the TV turn on Developer options >
// USB debugging / Network debugging, and put the TV's IP address in
// ANDROID_TV_HOST. The first time, the TV asks "Allow debugging?" — tick
// "Always allow" and accept.

const execFileAsync = promisify(execFile);

export type AdbRunner = (args: string[], timeoutMs?: number) => Promise<string>;

export function adbPath(): string {
  if (process.env.ANDROID_ADB_PATH) return process.env.ANDROID_ADB_PATH;
  const bundled = path.join(os.homedir(), ".ultron", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  return existsSync(bundled) ? bundled : "adb";
}

const defaultRunner: AdbRunner = async (args, timeoutMs = 12_000) => {
  try {
    const { stdout, stderr } = await execFileAsync(adbPath(), args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") throw new Error("ADB isn't installed — run scripts\\install-adb.ps1 once.");
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    throw new Error(out || e.message);
  }
};

let runner: AdbRunner = defaultRunner;
/** Test hook. */
export function setAdbRunner(r: AdbRunner | null): void {
  runner = r ?? defaultRunner;
}

export function tvConfigured(): boolean {
  return Boolean(process.env.ANDROID_TV_HOST?.trim());
}

function target(): string {
  const host = process.env.ANDROID_TV_HOST?.trim();
  if (!host) throw new Error("The TV isn't set up — put its IP address in ANDROID_TV_HOST in .env.local (see README).");
  if (!/^[\w.-]+(:\d+)?$/.test(host)) throw new Error(`ANDROID_TV_HOST "${host}" doesn't look like an address.`);
  return host.includes(":") ? host : `${host}:5555`;
}

/** Quotes one argument for the TV's shell (adb joins arguments into one
 *  command line, so everything that isn't a fixed word is quoted). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function statePath(): string {
  return path.join(os.homedir(), ".ultron", "tv.json");
}

async function savedMac(): Promise<string | null> {
  if (process.env.ANDROID_TV_MAC) return process.env.ANDROID_TV_MAC;
  try {
    return (JSON.parse(await fs.readFile(statePath(), "utf-8")) as { mac?: string }).mac ?? null;
  } catch {
    return null;
  }
}

/** Wake-on-LAN "magic packet": 6 × 0xFF then the MAC 16 times. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error(`"${mac}" isn't a MAC address.`);
  const macBytes = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => macBytes)]);
}

async function wakeOnLan(mac: string): Promise<void> {
  const packet = magicPacket(mac);
  const socket = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(packet, 9, "255.255.255.255", (err) => (err ? reject(err) : resolve()));
      });
    });
  } finally {
    socket.close();
  }
}

type ConnectResult = "ok" | "unauthorized" | "unreachable";

async function connect(): Promise<ConnectResult> {
  const t = target();
  const out = await runner(["connect", t]).catch((e: Error) => e.message);
  if (/unauthori[sz]ed|failed to authenticate/i.test(out)) return "unauthorized";
  if (!/connected to/i.test(out)) return "unreachable";
  const state = await runner(["-s", t, "get-state"]).catch((e: Error) => e.message);
  if (/unauthori[sz]ed/i.test(state)) return "unauthorized";
  if (!/device/.test(state)) return "unreachable";
  return "ok";
}

function connectError(r: ConnectResult): Error {
  return r === "unauthorized"
    ? new Error('The TV is asking to allow debugging — accept the prompt on the TV screen (tick "Always allow"), then ask again.')
    : new Error("Can't reach the TV — is it on and on the same Wi-Fi? If it's fully switched off, turn it on with the remote once and enable network standby.");
}

async function shell(command: string): Promise<string> {
  return runner(["-s", target(), "shell", command]);
}

async function ready(): Promise<void> {
  const r = await connect();
  if (r !== "ok") throw connectError(r);
  // Remember the TV's MAC so "turn on the TV" can wake it later.
  if (!(await savedMac())) {
    const mac = (await shell("cat /sys/class/net/eth0/address /sys/class/net/wlan0/address 2>/dev/null").catch(() => ""))
      .split(/\s+/)
      .find((m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(m) && m !== "00:00:00:00:00:00");
    if (mac) {
      await fs.mkdir(path.dirname(statePath()), { recursive: true });
      await fs.writeFile(statePath(), JSON.stringify({ mac }), "utf-8");
    }
  }
}

async function screenOn(): Promise<boolean> {
  const out = await shell("dumpsys power | grep -E 'mWakefulness=|Display Power: state='");
  return /mWakefulness=Awake|state=ON/i.test(out);
}

const KEYS: Record<string, number> = {
  home: 3,
  back: 4,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  ok: 23,
  select: 23,
  volume_up: 24,
  volume_down: 25,
  mute: 164,
  play_pause: 85,
  play: 126,
  pause: 127,
  stop: 86,
  next: 87,
  previous: 88,
  rewind: 89,
  fast_forward: 90,
  channel_up: 166,
  channel_down: 167,
  input: 178,
  settings: 176,
  menu: 82,
};

// Apps people ask for by name, with their Android TV package ids.
const APP_PACKAGES: Record<string, string[]> = {
  youtube: ["com.google.android.youtube.tv", "com.google.android.youtube"],
  netflix: ["com.netflix.ninja", "com.netflix.mediaclient"],
  "prime video": ["com.amazon.amazonvideo.livingroom", "com.amazon.avod.thirdpartyclient"],
  hotstar: ["in.startv.hotstar", "in.startv.hotstar.dplus.tv"],
  jiohotstar: ["in.startv.hotstar", "in.startv.hotstar.dplus.tv"],
  "disney+ hotstar": ["in.startv.hotstar", "in.startv.hotstar.dplus.tv"],
  jiocinema: ["com.jio.media.stb.ondemand", "com.jio.media.ondemand"],
  spotify: ["com.spotify.tv.android"],
  "youtube music": ["com.google.android.youtube.tvmusic"],
  sonyliv: ["com.sonyliv"],
  zee5: ["com.graymatrix.did"],
  plex: ["com.plexapp.android"],
  vlc: ["org.videolan.vlc"],
  kodi: ["org.xbmc.kodi"],
  "google play": ["com.android.vending"],
  "play store": ["com.android.vending"],
  settings: ["com.android.tv.settings", "com.android.settings"],
};

const PACKAGE_RE = /^[a-zA-Z][\w]*(\.[\w]+)+$/;

async function installedPackages(): Promise<string[]> {
  return (await shell("pm list packages"))
    .split(/\r?\n/)
    .map((l) => l.replace(/^package:/, "").trim())
    .filter((p) => PACKAGE_RE.test(p));
}

/** Picks the package for a spoken app name. */
export function pickPackage(name: string, installed: string[]): string | null {
  const n = name.trim().toLowerCase();
  if (PACKAGE_RE.test(name.trim()) && installed.includes(name.trim())) return name.trim();
  for (const pkg of APP_PACKAGES[n] ?? []) if (installed.includes(pkg)) return pkg;
  const squashed = n.replace(/[^a-z0-9]/g, "");
  if (!squashed) return null;
  const matches = installed.filter((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "").includes(squashed));
  // Prefer the TV build of an app when there are several.
  return matches.sort((a, b) => Number(/tv|leanback|ninja|livingroom/.test(b)) - Number(/tv|leanback|ninja|livingroom/.test(a)) || a.length - b.length)[0] ?? null;
}

async function launch(pkg: string): Promise<void> {
  for (const category of ["android.intent.category.LEANBACK_LAUNCHER", "android.intent.category.LAUNCHER"]) {
    const out = await shell(`cmd package resolve-activity --brief -c ${category} ${pkg}`).catch(() => "");
    const component = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .reverse()
      .find((l) => /^[\w.]+\/[\w.$]+$/.test(l));
    if (component) {
      await shell(`am start -n ${component}`);
      return;
    }
  }
  await shell(`monkey -p ${pkg} 1`);
}

export interface TvRequest {
  action: string;
  steps?: number;
  app?: string;
  query?: string;
  text?: string;
}

/** tv_control tool. */
export async function controlTv(req: TvRequest): Promise<string> {
  const action = req.action.trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (action === "power_on" || action === "on" || action === "turn_on") {
    let r = await connect();
    if (r === "unreachable") {
      const mac = await savedMac();
      if (!mac) throw connectError(r);
      await wakeOnLan(mac);
      for (let i = 0; i < 6 && r === "unreachable"; i++) {
        await new Promise((res) => setTimeout(res, 2500));
        r = await connect();
      }
    }
    if (r !== "ok") throw connectError(r);
    if (!(await screenOn())) await shell("input keyevent 224"); // WAKEUP
    return "The TV is on.";
  }

  await ready();

  switch (action) {
    case "power_off":
    case "off":
    case "turn_off":
      await shell("input keyevent 223"); // SLEEP
      return "The TV is off.";
    case "status": {
      const on = await screenOn();
      const focus = on ? await shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'").catch(() => "") : "";
      const app = focus.match(/([a-zA-Z][\w]*(?:\.[\w]+)+)\//)?.[1];
      return on ? `The TV is on${app ? `, showing ${app}` : ""}.` : "The TV is in standby.";
    }
    case "volume_up":
    case "volume_down": {
      const steps = Math.min(30, Math.max(1, Math.round(req.steps ?? 3)));
      await shell(`input keyevent ${Array(steps).fill(KEYS[action]).join(" ")}`);
      return `Volume ${action === "volume_up" ? "up" : "down"} ${steps} step${steps === 1 ? "" : "s"}.`;
    }
    case "open_app": {
      if (!req.app?.trim()) throw new Error("Which app?");
      const pkg = pickPackage(req.app, await installedPackages());
      if (!pkg) throw new Error(`"${req.app}" isn't installed on the TV.`);
      await launch(pkg);
      return `Opened ${req.app} on the TV.`;
    }
    case "youtube":
    case "youtube_search": {
      const q = (req.query ?? req.text ?? "").trim();
      if (!q) throw new Error("What should I look for on YouTube?");
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q).replace(/'/g, "%27")}`;
      const installed = await installedPackages();
      const pkg = APP_PACKAGES.youtube.find((p) => installed.includes(p));
      await shell(`am start -a android.intent.action.VIEW -d ${shQuote(url)}${pkg ? ` ${pkg}` : ""}`);
      return `Searching YouTube on the TV for "${q}".`;
    }
    case "type_text": {
      const text = (req.text ?? req.query ?? "").trim();
      if (!text) throw new Error("What should I type?");
      // `input text` needs spaces as %s; everything else is quoted.
      await shell(`input text ${shQuote(text.replace(/%/g, "\\%").replace(/ /g, "%s"))}`);
      return `Typed "${text}" on the TV.`;
    }
    default: {
      const key = KEYS[action];
      if (key === undefined) {
        throw new Error(`The TV can't "${req.action}". Try power_on, power_off, volume_up, volume_down, mute, play_pause, home, back, open_app, youtube_search.`);
      }
      const steps = ["up", "down", "left", "right"].includes(action) ? Math.min(20, Math.max(1, Math.round(req.steps ?? 1))) : 1;
      await shell(`input keyevent ${Array(steps).fill(key).join(" ")}`);
      return `Pressed ${action.replace(/_/g, " ")}${steps > 1 ? ` ×${steps}` : ""} on the TV.`;
    }
  }
}
