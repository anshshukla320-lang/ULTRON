import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOT, ensureWorkspace } from "./workspace";
import type { ToolOutput } from "./tools";

// "What does my rental agreement say about notice?" — search the user's
// documents and read them. Only the agent workspace plus folders the user
// lists in ULTRON_DOCUMENT_FOLDERS are ever looked at (read-only).

const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json", ".log", ".html", ".htm", ".rtf", ".xml", ".yaml", ".yml"]);
const DOC_EXTS = new Set([...TEXT_EXTS, ".pdf", ".docx"]);
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 3000;
const MAX_TEXT_CHARS = 400_000; // per document, for search
const CHUNK_CHARS = 1200;
// Claude reads PDFs natively (layout, tables, scans) up to 32 MB / 100 pages;
// past that, extracted text is sent instead.
const MAX_NATIVE_PDF_BYTES = 20 * 1024 * 1024;

/** Every folder document tools may read. */
export function documentRoots(): string[] {
  ensureWorkspace();
  const extra = (process.env.ULTRON_DOCUMENT_FOLDERS ?? "")
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir())));
  return [WORKSPACE_ROOT, ...extra];
}

function insideRoot(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolves a user/model-supplied path to a file inside an allowed root. */
export function resolveDocumentPath(p: string): string {
  const roots = documentRoots();
  const candidate = path.isAbsolute(p) ? path.resolve(p) : path.resolve(WORKSPACE_ROOT, p.replace(/^[/\\]+/, ""));
  if (!roots.some((r) => insideRoot(candidate, r))) {
    throw new Error(`"${p}" is outside the folders ULTRON may read (${roots.join(", ")}). Add its folder to ULTRON_DOCUMENT_FOLDERS to allow it.`);
  }
  return candidate;
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && DOC_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
    if (out.length >= MAX_FILES) return;
  }
}

/** Plain text of a document, page by page for PDFs. */
export async function extractPages(file: string): Promise<string[]> {
  const ext = path.extname(file).toLowerCase();
  const stat = await fs.stat(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} is too large to read (${Math.round(stat.size / 1024 / 1024)} MB).`);
  if (ext === ".pdf") {
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(await fs.readFile(file)), { mergePages: false });
    return text;
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: await fs.readFile(file) });
    return [value];
  }
  let text = await fs.readFile(file, "utf-8");
  if (ext === ".html" || ext === ".htm" || ext === ".xml") text = text.replace(/<[^>]+>/g, " ");
  return [text];
}

interface IndexEntry {
  mtimeMs: number;
  size: number;
  pages: string[];
}

function indexPath(): string {
  return path.join(os.homedir(), ".ultron", "docindex.json");
}

async function loadIndex(): Promise<Record<string, IndexEntry>> {
  try {
    return JSON.parse(await fs.readFile(indexPath(), "utf-8"));
  } catch {
    return {};
  }
}

/** Text of every document, re-extracting only files that changed. */
async function indexedDocuments(): Promise<Map<string, string[]>> {
  const files: string[] = [];
  for (const root of documentRoots()) await walk(root, files);
  const index = await loadIndex();
  const next: Record<string, IndexEntry> = {};
  let changed = false;
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      const cached = index[file];
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        next[file] = cached;
        continue;
      }
      let total = 0;
      const pages = (await extractPages(file)).map((p) => {
        const room = Math.max(0, MAX_TEXT_CHARS - total);
        total += Math.min(p.length, room);
        return p.slice(0, room);
      });
      next[file] = { mtimeMs: stat.mtimeMs, size: stat.size, pages };
      changed = true;
    } catch {
      // unreadable or encrypted — skip
    }
  }
  if (changed || Object.keys(index).length !== Object.keys(next).length) {
    await fs.mkdir(path.dirname(indexPath()), { recursive: true });
    await fs.writeFile(indexPath(), JSON.stringify(next), "utf-8");
  }
  return new Map(Object.entries(next).map(([f, e]) => [f, e.pages]));
}

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

interface Hit {
  file: string;
  page: number;
  text: string;
  score: number;
}

/** Ranks passages by query-term matches, rarer terms weighing more. */
export function rankPassages(docs: Map<string, string[]>, query: string, limit: number): Hit[] {
  const q = [...new Set(terms(query))];
  if (q.length === 0) return [];
  const passages: Omit<Hit, "score">[] = [];
  for (const [file, pages] of docs) {
    pages.forEach((pageText, i) => {
      for (let start = 0; start < pageText.length; start += CHUNK_CHARS) {
        passages.push({ file, page: i + 1, text: pageText.slice(start, start + CHUNK_CHARS + 200) });
      }
    });
  }
  const df = new Map(q.map((t) => [t, passages.filter((p) => p.text.toLowerCase().includes(t)).length]));
  const n = passages.length || 1;
  return passages
    .map((p) => {
      const lower = p.text.toLowerCase();
      let score = 0;
      for (const t of q) {
        const count = lower.split(t).length - 1;
        if (count) score += (1 + Math.log(count)) * Math.log(1 + n / (df.get(t) || 1));
      }
      return { ...p, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** search_documents tool. */
export async function searchDocuments(query: string, limit = 5): Promise<string> {
  if (!query.trim()) throw new Error("Give me something to search for.");
  const docs = await indexedDocuments();
  if (docs.size === 0) {
    return `No documents found. Put files in ${WORKSPACE_ROOT}, or list folders in ULTRON_DOCUMENT_FOLDERS.`;
  }
  const hits = rankPassages(docs, query, limit);
  if (hits.length === 0) return `Nothing in ${docs.size} document(s) mentions "${query}".`;
  return hits
    .map((h) => {
      const where = docs.get(h.file)!.length > 1 ? ` (page ${h.page})` : "";
      return `### ${h.file}${where}\n${h.text.replace(/\s+/g, " ").trim()}`;
    })
    .join("\n\n");
}

/** read_document tool: PDFs go to Claude as the real document. */
export async function readDocument(p: string): Promise<ToolOutput> {
  const file = resolveDocumentPath(p);
  const stat = await fs.stat(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf" && stat.size <= MAX_NATIVE_PDF_BYTES) {
    return {
      text: `Contents of ${path.basename(file)}.`,
      document: { mediaType: "application/pdf", data: (await fs.readFile(file)).toString("base64") },
    };
  }
  const pages = await extractPages(file);
  const text = pages.map((t, i) => (pages.length > 1 ? `--- page ${i + 1} ---\n${t}` : t)).join("\n");
  return text.length > 150_000 ? `${text.slice(0, 150_000)}\n\n[Truncated — the document is longer; ask about a specific part.]` : text;
}
