import { spawn, type ChildProcess } from "node:child_process";
import { keyToVk } from "./computerUse";

// One small hidden PowerShell process that lives as long as ULTRON does and
// reports two things from Windows: the global push-to-talk hotkey being
// pressed, and (every 15 s) which app is in front and how long the user has
// been idle — for screen time and focus mode. One process, compiled once,
// instead of a PowerShell launch every few seconds.

const SAMPLE_MS = 15_000;

const SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class UltronDesk {
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hWnd, UIntPtr id, uint ms, IntPtr fn);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  static string Foreground() {
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    uint pid; GetWindowThreadProcessId(h, out pid);
    string name = "";
    try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
    var li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(li); GetLastInputInfo(ref li);
    uint idle = unchecked((uint)Environment.TickCount - li.dwTime);
    return name + "\t" + sb.ToString().Replace("\t", " ").Replace("\n", " ") + "\t" + idle;
  }
  public static void Run(uint mods, uint vk, uint sampleMs) {
    bool ok = vk != 0 && RegisterHotKey(IntPtr.Zero, 1, mods | 0x4000, vk);
    Console.WriteLine(vk == 0 ? "HOTKEY-OFF" : ok ? "HOTKEY-OK" : "HOTKEY-TAKEN");
    if (sampleMs > 0) SetTimer(IntPtr.Zero, UIntPtr.Zero, sampleMs, IntPtr.Zero);
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.message == 0x0312) Console.WriteLine("HOTKEY");
      else if (m.message == 0x0113) Console.WriteLine("FG\t" + Foreground());
    }
  }
}
'@
[UltronDesk]::Run([uint32]$env:ULTRON_HK_MODS, [uint32]$env:ULTRON_HK_VK, [uint32]$env:ULTRON_SAMPLE_MS)
`;

const MODS: Record<string, number> = { alt: 0x1, ctrl: 0x2, control: 0x2, shift: 0x4, win: 0x8, windows: 0x8, super: 0x8 };

/** "Ctrl+Shift+Space" → RegisterHotKey's modifier flags and key code. */
export function parseHotkey(combo: string): { mods: number; vk: number } | null {
  const parts = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  let mods = 0;
  for (const p of parts.slice(0, -1)) {
    if (!(p in MODS)) throw new Error(`"${p}" isn't a modifier key (use Ctrl, Alt, Shift or Win).`);
    mods |= MODS[p];
  }
  const key = parts[parts.length - 1];
  if (key in MODS) throw new Error("The hotkey needs a normal key after the modifiers, e.g. Ctrl+Shift+Space.");
  if (!mods && !/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) throw new Error("Use at least one of Ctrl, Alt, Shift or Win (or an F-key) so the hotkey doesn't fire while typing.");
  return { mods, vk: keyToVk(key) };
}

export type HelperLine = { type: "hotkey" } | { type: "hotkey-status"; status: "ok" | "taken" | "off" } | { type: "foreground"; process: string; title: string; idleMs: number };

export function parseHelperLine(line: string): HelperLine | null {
  const l = line.replace(/\r$/, "");
  if (l === "HOTKEY") return { type: "hotkey" };
  if (l.startsWith("HOTKEY-")) return { type: "hotkey-status", status: l === "HOTKEY-OK" ? "ok" : l === "HOTKEY-TAKEN" ? "taken" : "off" };
  if (l.startsWith("FG\t")) {
    const [, proc = "", title = "", idle = "0"] = l.split("\t");
    return { type: "foreground", process: proc, title, idleMs: Number(idle) || 0 };
  }
  return null;
}

export interface HelperHandle {
  stop(): void;
}

/** Starts the helper (Windows only) and restarts it if it dies. */
export function startDesktopHelper(hotkey: string, onLine: (l: HelperLine) => void): HelperHandle | null {
  if (process.platform !== "win32") return null;
  let keys: { mods: number; vk: number } | null = null;
  try {
    keys = hotkey ? parseHotkey(hotkey) : null;
  } catch (err) {
    console.error(`ULTRON hotkey "${hotkey}" ignored: ${(err as Error).message}`);
  }
  let child: ChildProcess | null = null;
  let stopped = false;
  const launch = () => {
    if (stopped) return;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
      env: { ...process.env, ULTRON_HK_MODS: String(keys?.mods ?? 0), ULTRON_HK_VK: String(keys?.vk ?? 0), ULTRON_SAMPLE_MS: String(SAMPLE_MS) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const parsed = parseHelperLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (parsed) onLine(parsed);
      }
    });
    child.on("exit", () => {
      child = null;
      if (!stopped) setTimeout(launch, 10_000).unref();
    });
    child.on("error", () => {});
  };
  launch();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}
