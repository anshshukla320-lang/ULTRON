import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./workspace";

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      result.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

/**
 * Basic per-column stats for a CSV in the agent's sandboxed workspace —
 * numeric columns get min/max/mean/median, text columns get a distinct
 * value count. No pandas/Python dependency required.
 */
export async function analyzeCsv(relativePath: string): Promise<string> {
  const filePath = resolveWorkspacePath(relativePath);
  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header row plus at least one data row.");

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);

  const summaries = headers.map((header, colIdx) => {
    const values = rows.map((r) => r[colIdx]?.trim()).filter((v): v is string => v !== undefined && v !== "");
    const numeric = values.map(Number).filter((n) => !Number.isNaN(n));
    if (numeric.length === values.length && numeric.length > 0) {
      const sum = numeric.reduce((a, b) => a + b, 0);
      const mean = sum / numeric.length;
      const sorted = [...numeric].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return `${header}: numeric — min ${Math.min(...numeric)}, max ${Math.max(...numeric)}, mean ${mean.toFixed(2)}, median ${median}`;
    }
    const unique = new Set(values).size;
    return `${header}: text — ${unique} unique value(s)`;
  });

  return `${path.basename(filePath)}: ${rows.length} rows, ${headers.length} columns.\n${summaries.join("\n")}`;
}
