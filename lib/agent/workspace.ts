import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The agent may only read/write files inside this single folder. Keeping it
 * separate from the rest of the filesystem means a bad transcription, a
 * prompt-injected instruction, or an LLM mistake can't touch anything the
 * user actually cares about.
 */
export const WORKSPACE_ROOT = path.join(os.homedir(), "ULTRON-Agent-Files");

export function ensureWorkspace(): string {
  if (!existsSync(WORKSPACE_ROOT)) {
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }
  return WORKSPACE_ROOT;
}

/**
 * Resolves a user-supplied relative path against the workspace root and
 * throws if it would escape the root (path traversal, absolute paths,
 * drive-letter switches, etc).
 */
export function resolveWorkspacePath(relativePath: string): string {
  ensureWorkspace();
  const cleaned = relativePath.replace(/^[/\\]+/, "");
  const resolved = path.resolve(WORKSPACE_ROOT, cleaned);
  const rootWithSep = WORKSPACE_ROOT.endsWith(path.sep)
    ? WORKSPACE_ROOT
    : WORKSPACE_ROOT + path.sep;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `Path "${relativePath}" is outside the agent workspace (${WORKSPACE_ROOT}).`,
    );
  }
  return resolved;
}
