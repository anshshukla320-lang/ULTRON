import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWorkspacePath, WORKSPACE_ROOT, ensureWorkspace } from "./workspace";

const execFileAsync = promisify(execFile);

/**
 * Launches a process and returns as soon as it has actually started, without
 * waiting for it to exit. Using `stdio: "ignore"` + `detached` + `unref` is
 * required on Windows: an inherited stdio pipe to a GUI app can keep Node's
 * child_process promise from ever resolving until that app is closed.
 */
function launchDetached(command: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: false });
    child.once("error", reject);
    setImmediate(() => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Hands a target (URL, URI scheme, .lnk shortcut, or bare exe name) to
 * Windows' own "open" mechanism — the same one behind double-click and the
 * Run dialog. Spawning `explorer.exe <target>` directly is not reliable: it
 * can report success without actually surfacing anything, since `explorer`
 * only relays the request to the real shell process rather than opening it
 * itself. `cmd /c start` is the confirmed-working native idiom for this.
 * The empty "" argument is required so `start` doesn't mistake the target
 * for its optional window-title argument when it's quoted.
 */
function openWithShell(target: string): Promise<void> {
  return launchDetached("cmd.exe", ["/c", "start", "", target]);
}

const MAX_READ_BYTES = 100_000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;

// Well-known system apps that aren't reliably discoverable as Start Menu
// shortcuts. Everything else is resolved by searching real shortcuts below,
// so we never invent an arbitrary path to execute.
const KNOWN_APPS: Record<string, string> = {
  notepad: "notepad.exe",
  calculator: "calc.exe",
  calc: "calc.exe",
  paint: "mspaint.exe",
  explorer: "explorer.exe",
  "file explorer": "explorer.exe",
  terminal: "wt.exe",
  "command prompt": "cmd.exe",
  cmd: "cmd.exe",
  powershell: "powershell.exe",
  settings: "ms-settings:",
  "task manager": "taskmgr.exe",
  control: "control.exe",
  "control panel": "control.exe",
};

const START_MENU_DIRS = [
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  path.join(os.homedir(), "AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs"),
];

async function findShortcut(query: string): Promise<string | null> {
  const needle = query.trim().toLowerCase();
  let best: { score: number; file: string } | null = null;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith(".lnk")) {
        const base = entry.name.slice(0, -4).toLowerCase();
        if (base === needle) {
          best = { score: 0, file: full };
        } else if (base.includes(needle) && (!best || best.score > 1)) {
          best = { score: 1, file: full };
        }
      }
    }
  }

  for (const dir of START_MENU_DIRS) {
    await walk(dir, 0);
    if (best && (best as { score: number }).score === 0) break;
  }
  return best ? (best as { file: string }).file : null;
}

export async function openApp(name: string): Promise<string> {
  const key = name.trim().toLowerCase();
  const known = KNOWN_APPS[key];
  if (known) {
    await openWithShell(known);
    return `Launched "${name}".`;
  }

  const shortcut = await findShortcut(key);
  if (shortcut) {
    await openWithShell(shortcut);
    return `Launched "${name}".`;
  }

  throw new Error(
    `Couldn't find an installed application matching "${name}". Try the exact app name as it appears in the Start menu.`,
  );
}

export async function openUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http/https URLs can be opened (got "${url.protocol}").`);
  }
  await openWithShell(url.toString());
  return `Opened ${url.toString()} in the default browser.`;
}

const SEARCH_SITES: Record<string, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
};

export async function openSearch(query: string, site = "google"): Promise<string> {
  const key = site.trim().toLowerCase();
  const build = SEARCH_SITES[key] ?? SEARCH_SITES.google;
  const url = build(query);
  await openWithShell(url);
  return `Opened a ${key in SEARCH_SITES ? key : "google"} search for "${query}" in the browser.`;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

async function braveApiSearch(query: string, count = 5): Promise<BraveWebResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is missing from .env.local.");
  }

  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?count=${count}&q=${encodeURIComponent(query)}`,
    { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
  );

  if (!res.ok) {
    throw new Error(`Web search failed (${res.status} ${res.statusText}).`);
  }

  const data = (await res.json()) as { web?: { results?: BraveWebResult[] } };
  return data.web?.results ?? [];
}

export async function webSearch(query: string): Promise<string> {
  let results: BraveWebResult[];
  try {
    results = await braveApiSearch(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg} Use open_search to open a search page in the browser instead.`);
  }
  if (results.length === 0) return `No web results found for "${query}".`;

  return results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.description ?? ""}\n   ${r.url ?? ""}`)
    .join("\n\n");
}

const YOUTUBE_WATCH_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/;

export async function playMusic(query: string): Promise<string> {
  try {
    const results = await braveApiSearch(`${query} site:youtube.com`, 8);
    const match = results.map((r) => r.url ?? "").map((u) => u.match(YOUTUBE_WATCH_RE)).find(Boolean);
    const videoId = match?.[1];

    if (videoId) {
      await openWithShell(`https://www.youtube.com/watch?v=${videoId}&autoplay=1`);
      return `Playing "${query}" on YouTube. If your browser blocks autoplay on the first try, one click on the video starts it.`;
    }
  } catch {
    // fall through to the search-page fallback below
  }

  await openWithShell(SEARCH_SITES.youtube(query));
  return `Couldn't auto-play "${query}" — opened YouTube search results instead. Pick a track and press play manually.`;
}

export async function listFiles(relativePath = "."): Promise<string> {
  const dir = resolveWorkspacePath(relativePath);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  if (lines.length === 0) return `(empty) ${dir === WORKSPACE_ROOT ? "workspace root" : relativePath}`;
  return lines.join("\n");
}

export async function readFile(relativePath: string): Promise<string> {
  const file = resolveWorkspacePath(relativePath);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`"${relativePath}" is not a file.`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`"${relativePath}" is too large to read (${stat.size} bytes, limit ${MAX_READ_BYTES}).`);
  }
  return fs.readFile(file, "utf-8");
}

export async function writeFile(relativePath: string, content: string): Promise<string> {
  const file = resolveWorkspacePath(relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf-8");
  return `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${relativePath}.`;
}

export async function searchFiles(query: string, relativePath = "."): Promise<string> {
  const root = resolveWorkspacePath(relativePath);
  const needle = query.trim().toLowerCase();
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || results.length >= MAX_SEARCH_RESULTS) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) return;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(needle)) {
        results.push(path.relative(WORKSPACE_ROOT, full) + (entry.isDirectory() ? "/" : ""));
      }
      if (entry.isDirectory()) await walk(full, depth + 1);
    }
  }

  await walk(root, 0);
  return results.length ? results.join("\n") : `No files matching "${query}" found.`;
}

function parseWingetTable(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const sepIndex = lines.findIndex((l) => /^-{5,}$/.test(l.trim()));
  const rows = sepIndex >= 0 ? lines.slice(sepIndex + 1) : [];
  return rows.slice(0, 10).join("\n");
}

export async function searchApp(query: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("winget", ["search", query, "--accept-source-agreements"], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    const rows = parseWingetTable(stdout);
    return rows || `No installable packages found matching "${query}".`;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) {
      const rows = parseWingetTable(stdout);
      if (rows) return rows;
    }
    throw new Error(`App search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function installApp(id: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "winget",
      ["install", "--id", id, "-e", "--accept-package-agreements", "--accept-source-agreements", "--silent"],
      { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 },
    );
    return `Installed "${id}".`.concat(stdout ? ` ${stdout.trim().split(/\r?\n/).slice(-1)[0]}` : "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Install failed for "${id}": ${msg}`);
  }
}

export async function getSystemInfo(): Promise<string> {
  ensureWorkspace();
  const uptimeMin = Math.round(os.uptime() / 60);
  const freeGb = (os.freemem() / 1024 ** 3).toFixed(1);
  const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  return [
    `Time: ${new Date().toLocaleString()}`,
    `Host: ${os.hostname()} (${os.platform()} ${os.release()})`,
    `Uptime: ${uptimeMin} min`,
    `Memory: ${freeGb} GB free / ${totalGb} GB total`,
    `CPU cores: ${os.cpus().length}`,
    `Agent workspace: ${WORKSPACE_ROOT}`,
  ].join("\n");
}
