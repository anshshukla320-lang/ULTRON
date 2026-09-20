import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DISK_WARN_PCT = 85;
const MEM_WARN_PCT = 85;
const CPU_WARN_PCT = 85;

export interface DiskInfo {
  drive: string;
  freeGb: number;
  totalGb: number;
  percentUsed: number;
}

export interface SystemErrorEvent {
  time: string;
  source: string;
  message: string;
}

export interface MachineHealth {
  hostname: string;
  uptimeMin: number;
  disks: DiskInfo[];
  memPercentUsed: number;
  cpuLoadPercent: number | null;
  recentErrors: SystemErrorEvent[];
}

export interface HealthIssue {
  kind: "disk" | "memory" | "cpu" | "errors";
  detail: string;
}

async function runPowerShell(command: string): Promise<string> {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function getDisks(): Promise<DiskInfo[]> {
  try {
    const raw = await runPowerShell(
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress',
    );
    const rows = parseJsonArray<{ DeviceID: string; Size: number; FreeSpace: number }>(raw);
    return rows
      .filter((r) => r.Size > 0)
      .map((r) => {
        const totalGb = r.Size / 1024 ** 3;
        const freeGb = r.FreeSpace / 1024 ** 3;
        return {
          drive: r.DeviceID,
          totalGb: Math.round(totalGb * 10) / 10,
          freeGb: Math.round(freeGb * 10) / 10,
          percentUsed: Math.round(((r.Size - r.FreeSpace) / r.Size) * 100),
        };
      });
  } catch {
    return [];
  }
}

async function getCpuLoadPercent(): Promise<number | null> {
  try {
    const raw = await runPowerShell(
      "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
    );
    const n = parseFloat(raw);
    return Number.isFinite(n) ? Math.round(n) : null;
  } catch {
    return null;
  }
}

async function getRecentErrors(): Promise<SystemErrorEvent[]> {
  try {
    const raw = await runPowerShell(
      "Get-WinEvent -FilterHashtable @{LogName='System';Level=1,2;StartTime=(Get-Date).AddHours(-24)} " +
        "-MaxEvents 10 -ErrorAction SilentlyContinue | " +
        "Select-Object TimeCreated,ProviderName,@{N='Msg';E={$_.Message.Substring(0,[Math]::Min(140,$_.Message.Length))}} | " +
        "ConvertTo-Json -Compress",
    );
    const rows = parseJsonArray<{ TimeCreated: string; ProviderName: string; Msg: string }>(raw);
    return rows.map((r) => ({ time: r.TimeCreated, source: r.ProviderName, message: r.Msg }));
  } catch {
    return [];
  }
}

export async function gatherMachineHealth(): Promise<{ health: MachineHealth; issues: HealthIssue[] }> {
  const [disks, cpuLoadPercent, recentErrors] = await Promise.all([getDisks(), getCpuLoadPercent(), getRecentErrors()]);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercentUsed = Math.round(((totalMem - freeMem) / totalMem) * 100);

  const health: MachineHealth = {
    hostname: os.hostname(),
    uptimeMin: Math.round(os.uptime() / 60),
    disks,
    memPercentUsed,
    cpuLoadPercent,
    recentErrors,
  };

  const issues: HealthIssue[] = [];
  for (const d of disks) {
    if (d.percentUsed >= DISK_WARN_PCT) {
      issues.push({ kind: "disk", detail: `drive ${d.drive} is ${d.percentUsed} percent full, only ${d.freeGb} gigabytes free` });
    }
  }
  if (memPercentUsed >= MEM_WARN_PCT) {
    issues.push({ kind: "memory", detail: `memory usage is at ${memPercentUsed} percent` });
  }
  if (cpuLoadPercent !== null && cpuLoadPercent >= CPU_WARN_PCT) {
    issues.push({ kind: "cpu", detail: `C P U load is at ${cpuLoadPercent} percent` });
  }
  if (recentErrors.length > 0) {
    issues.push({ kind: "errors", detail: `${recentErrors.length} system error${recentErrors.length === 1 ? "" : "s"} logged in the last 24 hours` });
  }

  return { health, issues };
}
