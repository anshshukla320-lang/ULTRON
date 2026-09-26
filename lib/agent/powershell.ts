import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function requireWindows(feature: string): void {
  if (process.platform !== "win32") throw new Error(`${feature} only works on Windows.`);
}

/**
 * Runs a fixed PowerShell script. Anything that came from the model or the
 * user goes in `env` and is read inside the script as $env:NAME — never
 * pasted into the script text — so it can't be interpreted as code.
 */
export async function runPowerShell(script: string, env: Record<string, string> = {}, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    // Windows PowerShell writes stdout in the console's legacy code page, so
    // anything non-English (Hindi, accents) came back as "?" — force UTF-8.
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
  );
  return stdout.trim();
}
