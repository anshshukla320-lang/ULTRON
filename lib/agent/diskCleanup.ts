import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPowerShell } from "./powershell";

// Junk that's always safe to remove. Downloads and Windows Update files are
// only ever *reported*: Downloads is the user's own stuff, and the update
// cache needs admin rights (Disk Cleanup handles it properly).

export type CleanupCategory = "temp_files" | "browser_cache" | "thumbnail_cache" | "npm_cache" | "recycle_bin";
export const CLEANUP_CATEGORIES: CleanupCategory[] = ["temp_files", "browser_cache", "thumbnail_cache", "npm_cache", "recycle_bin"];

const DAY_MS = 24 * 60 * 60 * 1000;
// Files an installer or open app is using right now are usually recent;
// leave anything touched in the last day.
const TEMP_MIN_AGE_MS = DAY_MS;
const OLD_DOWNLOAD_AGE_MS = 30 * DAY_MS;
const MAX_ENTRIES = 300_000;

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
}

/** Directories whose *contents* make up each category. Resolved per call so
 *  tests can point the environment at temp folders. */
export function categoryDirs(category: CleanupCategory): string[] {
  const lad = localAppData();
  switch (category) {
    case "temp_files":
      return [os.tmpdir(), ...(process.platform === "win32" ? ["C:\\Windows\\Temp"] : [])];
    case "browser_cache":
      return [
        path.join(lad, "Google", "Chrome", "User Data"),
        path.join(lad, "Microsoft", "Edge", "User Data"),
        path.join(lad, "BraveSoftware", "Brave-Browser", "User Data"),
      ];
    case "thumbnail_cache":
      return [path.join(lad, "Microsoft", "Windows", "Explorer")];
    case "npm_cache":
      return [path.join(lad, "npm-cache", "_cacache")];
    case "recycle_bin":
      return [];
  }
}

interface Walk {
  bytes: number;
  files: string[];
}

/** Sums file sizes under `dir` (not following symlinks). `filter` decides
 *  which files count; collected paths are what a clean would delete. */
async function walk(dir: string, filter: (file: string, stat: import("node:fs").Stats) => boolean, out: Walk = { bytes: 0, files: [] }): Promise<Walk> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.files.length >= MAX_ENTRIES) break;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(full, filter, out);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        if (filter(full, stat)) {
          out.bytes += stat.size;
          out.files.push(full);
        }
      } catch {
        // vanished or locked
      }
    }
  }
  return out;
}

// Only real cache folders inside a browser profile — never cookies,
// history, passwords or extensions, which live next to them.
const BROWSER_CACHE_DIRS = new Set(["cache", "code cache", "gpucache", "shadercache", "grshadercache", "dawncache"]);

function inBrowserCacheDir(file: string, root: string): boolean {
  return path
    .relative(root, file)
    .split(path.sep)
    .some((part) => BROWSER_CACHE_DIRS.has(part.toLowerCase()));
}

async function collect(category: CleanupCategory, now = Date.now()): Promise<Walk> {
  const total: Walk = { bytes: 0, files: [] };
  for (const dir of categoryDirs(category)) {
    const filter = (file: string, stat: import("node:fs").Stats): boolean => {
      if (category === "temp_files") return now - stat.mtimeMs > TEMP_MIN_AGE_MS;
      if (category === "browser_cache") return inBrowserCacheDir(file, dir);
      if (category === "thumbnail_cache") return /^(thumbcache|iconcache)_.*\.db$/i.test(path.basename(file));
      return true;
    };
    await walk(dir, filter, total);
  }
  return total;
}

async function recycleBinBytes(): Promise<number> {
  if (process.platform !== "win32") return 0;
  try {
    const out = await runPowerShell(
      "$sum = 0; (New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $sum += [int64]$_.ExtendedProperty('Size') }; $sum",
    );
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

const LABELS: Record<CleanupCategory, string> = {
  temp_files: "Temporary files (older than a day)",
  browser_cache: "Browser caches (Chrome/Edge/Brave — not history, cookies or passwords)",
  thumbnail_cache: "Thumbnail cache (Windows rebuilds it)",
  npm_cache: "npm download cache",
  recycle_bin: "Recycle Bin",
};

/** Report only — nothing is deleted. */
export async function scanDiskJunk(): Promise<string> {
  const lines: string[] = [];
  let total = 0;
  for (const category of CLEANUP_CATEGORIES) {
    const bytes = category === "recycle_bin" ? await recycleBinBytes() : (await collect(category)).bytes;
    total += bytes;
    lines.push(`${category}: ${formatBytes(bytes)} — ${LABELS[category]}`);
  }

  // Report-only extras.
  const downloads = path.join(os.homedir(), "Downloads");
  const now = Date.now();
  const oldInstallers = await walk(downloads, (f, s) => /\.(exe|msi|zip|iso)$/i.test(f) && now - s.mtimeMs > OLD_DOWNLOAD_AGE_MS);
  if (oldInstallers.files.length) {
    const names = oldInstallers.files.slice(0, 5).map((f) => path.basename(f));
    lines.push(
      `Not deleted automatically — Downloads has ${oldInstallers.files.length} installer/archive file(s) older than 30 days (${formatBytes(oldInstallers.bytes)}), e.g. ${names.join(", ")}. The user should review these.`,
    );
  }
  lines.push("Windows Update leftovers need admin rights: the user can run Disk Cleanup > 'Clean up system files'.");
  return `Safe to clean: ${formatBytes(total)} in total.\n${lines.join("\n")}`;
}

/** Deletes the chosen categories. Files in use are skipped, not forced. */
export async function cleanDiskJunk(categories: string[]): Promise<string> {
  const chosen = categories.map((c) => c.trim().toLowerCase()).filter(Boolean);
  const unknown = chosen.filter((c) => !CLEANUP_CATEGORIES.includes(c as CleanupCategory));
  if (unknown.length) throw new Error(`Unknown categories: ${unknown.join(", ")}. Use: ${CLEANUP_CATEGORIES.join(", ")}.`);
  if (chosen.length === 0) throw new Error("Choose at least one category to clean.");

  const lines: string[] = [];
  let freedTotal = 0;
  for (const category of chosen as CleanupCategory[]) {
    if (category === "recycle_bin") {
      const before = await recycleBinBytes();
      try {
        await runPowerShell("Clear-RecycleBin -Force -ErrorAction SilentlyContinue");
        freedTotal += before;
        lines.push(`recycle_bin: emptied (${formatBytes(before)}).`);
      } catch (err) {
        lines.push(`recycle_bin: couldn't empty — ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    const { files } = await collect(category);
    let freed = 0;
    let skipped = 0;
    for (const file of files) {
      try {
        const { size } = await fs.stat(file);
        await fs.unlink(file);
        freed += size;
      } catch {
        skipped++; // in use or no permission — leave it
      }
    }
    freedTotal += freed;
    lines.push(`${category}: freed ${formatBytes(freed)}${skipped ? ` (${skipped} file(s) in use, skipped)` : ""}.`);
  }
  return `Freed ${formatBytes(freedTotal)} in total.\n${lines.join("\n")}`;
}
