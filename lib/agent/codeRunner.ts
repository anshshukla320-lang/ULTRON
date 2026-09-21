import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORKSPACE_ROOT, ensureWorkspace } from "./workspace";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 8_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n... (truncated)` : s;
}

function commandFor(language: string, code: string): { command: string; args: string[] } {
  const lang = language.trim().toLowerCase();
  if (lang === "node" || lang === "javascript" || lang === "js") {
    return { command: "node", args: ["-e", code] };
  }
  if (lang === "python" || lang === "py") {
    return { command: "python", args: ["-c", code] };
  }
  if (lang === "powershell" || lang === "ps1") {
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", code] };
  }
  throw new Error(`Unsupported language "${language}". Use node, python, or powershell.`);
}

/**
 * Runs a short script with its cwd inside the agent's sandboxed workspace
 * folder — but this is NOT a real sandbox. The code runs with the same
 * permissions as the user's own account; only the *working directory* is
 * scoped, not what the code is actually allowed to do. That's why this is
 * confirm-required rather than auto-execute.
 */
export async function runCode(language: string, code: string): Promise<string> {
  ensureWorkspace();
  const { command, args } = commandFor(language, code);

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: WORKSPACE_ROOT,
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const out = [stdout && `stdout:\n${truncate(stdout)}`, stderr && `stderr:\n${truncate(stderr)}`].filter(Boolean).join("\n\n");
    return out || "(no output)";
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new Error(`Code timed out after ${TIMEOUT_MS / 1000}s.`);
    const out = [e.stdout && `stdout:\n${truncate(e.stdout)}`, e.stderr && `stderr:\n${truncate(e.stderr)}`].filter(Boolean).join("\n\n");
    throw new Error(out || e.message || "Code execution failed.");
  }
}
