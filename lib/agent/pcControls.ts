import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireWindows, runPowerShell } from "./powershell";

const execFileAsync = promisify(execFile);

// Virtual-key codes for the media/volume keys on a keyboard. Pressing them
// is exactly what the physical keys do, so it works with every app and the
// Windows volume overlay, with no extra software.
const VK = {
  volumeMute: 0xad,
  volumeDown: 0xae,
  volumeUp: 0xaf,
  nextTrack: 0xb0,
  previousTrack: 0xb1,
  stop: 0xb2,
  playPause: 0xb3,
} as const;

// Reads the key and press count from the environment; see runPowerShell.
const PRESS_KEYS_SCRIPT = `
$sig = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'
$k = Add-Type -MemberDefinition $sig -Name Keys -Namespace UltronInput -PassThru
foreach ($pair in $env:ULTRON_KEYS.Split(',')) {
  $vk, $times = $pair.Split('x')
  for ($i = 0; $i -lt [int]$times; $i++) {
    $k::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    $k::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 8
  }
}`;

/** Exported for tests: the key sequence each action presses. */
export function volumeKeySequence(action: string, amount?: number): { keys: [number, number][]; summary: string } {
  // Each volume key press moves Windows' volume by 2%.
  const steps = (pct: number) => Math.max(1, Math.round(Math.min(Math.max(pct, 0), 100) / 2));
  switch (action) {
    case "up":
      return { keys: [[VK.volumeUp, steps(amount ?? 10)]], summary: `Volume up ${amount ?? 10}%.` };
    case "down":
      return { keys: [[VK.volumeDown, steps(amount ?? 10)]], summary: `Volume down ${amount ?? 10}%.` };
    case "set": {
      if (amount === undefined || !Number.isFinite(amount)) throw new Error("Give a volume level from 0 to 100.");
      const level = Math.min(Math.max(Math.round(amount), 0), 100);
      // No way to read the current level with key presses, so go to zero
      // first, then up to the target.
      const up = Math.round(level / 2);
      return { keys: up ? [[VK.volumeDown, 50], [VK.volumeUp, up]] : [[VK.volumeDown, 50]], summary: `Volume set to ${up * 2}%.` };
    }
    case "mute":
    case "unmute":
    case "toggle_mute":
      return { keys: [[VK.volumeMute, 1]], summary: "Toggled mute." };
    default:
      throw new Error(`Unknown volume action "${action}". Use up, down, set, or toggle_mute.`);
  }
}

async function pressKeys(keys: [number, number][]): Promise<void> {
  requireWindows("Volume and media keys");
  await runPowerShell(PRESS_KEYS_SCRIPT, { ULTRON_KEYS: keys.map(([vk, n]) => `${vk}x${n}`).join(",") });
}

export async function setVolume(action: string, amount?: number): Promise<string> {
  const { keys, summary } = volumeKeySequence(action.trim().toLowerCase(), amount);
  await pressKeys(keys);
  return summary;
}

export async function mediaControl(action: string): Promise<string> {
  const map: Record<string, [number, string]> = {
    play_pause: [VK.playPause, "Toggled play/pause."],
    play: [VK.playPause, "Toggled play/pause."],
    pause: [VK.playPause, "Toggled play/pause."],
    next: [VK.nextTrack, "Skipped to the next track."],
    previous: [VK.previousTrack, "Went to the previous track."],
    stop: [VK.stop, "Stopped playback."],
  };
  const hit = map[action.trim().toLowerCase()];
  if (!hit) throw new Error(`Unknown media action "${action}". Use play_pause, next, previous, or stop.`);
  await pressKeys([[hit[0], 1]]);
  return hit[1];
}

export async function lockPc(): Promise<string> {
  requireWindows("Locking the PC");
  await execFileAsync("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true });
  return "PC locked.";
}

export async function setBrightness(level: number): Promise<string> {
  requireWindows("Brightness control");
  if (!Number.isFinite(level)) throw new Error("Give a brightness level from 0 to 100.");
  const value = Math.min(Math.max(Math.round(level), 0), 100);
  try {
    await runPowerShell(
      "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$env:ULTRON_LEVEL } | Out-Null",
      { ULTRON_LEVEL: String(value) },
    );
  } catch {
    // Desktop monitors don't expose brightness to Windows (only laptop
    // panels do) — say that rather than a raw WMI error.
    throw new Error("This display doesn't let Windows change its brightness — that usually means an external monitor; use its own buttons.");
  }
  return `Brightness set to ${value}%.`;
}

const SHUTDOWN_DELAY_S = 60;

/** Sleep, shut down or restart. Shutdown/restart wait a minute (with a
 *  Windows notice) so cancel_shutdown can still stop them. */
export async function powerAction(action: string): Promise<string> {
  requireWindows("Power actions");
  switch (action.trim().toLowerCase()) {
    case "sleep":
      // SetSuspendState via .NET really sleeps; the rundll32 powrprof trick
      // hibernates instead when hibernation is enabled.
      await runPowerShell("Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)");
      return "Going to sleep.";
    case "shutdown":
      await execFileAsync("shutdown.exe", ["/s", "/t", String(SHUTDOWN_DELAY_S), "/c", "ULTRON: shutting down in 1 minute."], { windowsHide: true });
      return `Shutting down in ${SHUTDOWN_DELAY_S} seconds. Say "cancel the shutdown" to stop it.`;
    case "restart":
      await execFileAsync("shutdown.exe", ["/r", "/t", String(SHUTDOWN_DELAY_S), "/c", "ULTRON: restarting in 1 minute."], { windowsHide: true });
      return `Restarting in ${SHUTDOWN_DELAY_S} seconds. Say "cancel the restart" to stop it.`;
    default:
      throw new Error(`Unknown power action "${action}". Use sleep, shutdown, or restart.`);
  }
}

export async function cancelShutdown(): Promise<string> {
  requireWindows("Cancelling a shutdown");
  try {
    await execFileAsync("shutdown.exe", ["/a"], { windowsHide: true });
  } catch {
    return "There was no shutdown or restart scheduled.";
  }
  return "Cancelled the scheduled shutdown/restart.";
}
