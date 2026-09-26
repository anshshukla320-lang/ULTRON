import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Tracks what ULTRON spends on the Claude API: every response's token usage
// is priced and appended to ~/.ultron/usage.jsonl.

export type Feature = "chat" | "memory" | "computer" | "telegram" | "background";

// USD per million tokens (input, output). Cache writes cost 1.25x input
// (5-minute TTL), cache reads 0.1x input.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const FALLBACK_PRICE = PRICES["claude-opus-5"]; // unknown model: assume the dearer tier

interface TokenCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface UsageLike extends TokenCounts {
  // With the advisor (and other multi-step server features) the API splits
  // usage per model into iterations; the top-level numbers then only cover
  // part of it.
  iterations?: (TokenCounts & { model?: string | null; type?: string })[] | null;
}

interface UsageRecord {
  at: string;
  feature: Feature;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  usd: number;
}

function usagePath(): string {
  return path.join(os.homedir(), ".ultron", "usage.jsonl");
}

export function priceOf(model: string, t: TokenCounts): number {
  const p = PRICES[model] ?? FALLBACK_PRICE;
  const input = t.input_tokens ?? 0;
  const write = t.cache_creation_input_tokens ?? 0;
  const read = t.cache_read_input_tokens ?? 0;
  const output = t.output_tokens ?? 0;
  return (input * p.input + write * p.input * 1.25 + read * p.input * 0.1 + output * p.output) / 1_000_000;
}

/** Splits a response's usage into one record per model. */
export function usageRecords(feature: Feature, model: string, usage: UsageLike, at = new Date()): UsageRecord[] {
  const parts = usage.iterations?.length
    ? usage.iterations.map((it) => ({ model: it.model || model, t: it }))
    : [{ model, t: usage as TokenCounts }];
  return parts.map(({ model: m, t }) => ({
    at: at.toISOString(),
    feature,
    model: m,
    input: t.input_tokens ?? 0,
    output: t.output_tokens ?? 0,
    cacheWrite: t.cache_creation_input_tokens ?? 0,
    cacheRead: t.cache_read_input_tokens ?? 0,
    usd: priceOf(m, t),
  }));
}

export async function recordUsage(feature: Feature, model: string, usage: UsageLike | null | undefined): Promise<void> {
  if (!usage) return;
  try {
    const lines = usageRecords(feature, model, usage).map((r) => JSON.stringify(r)).join("\n");
    await fs.mkdir(path.dirname(usagePath()), { recursive: true });
    await fs.appendFile(usagePath(), `${lines}\n`, "utf-8");
  } catch {
    // tracking must never break a reply
  }
}

async function readRecords(): Promise<UsageRecord[]> {
  try {
    return (await fs.readFile(usagePath(), "utf-8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as UsageRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface UsageSummary {
  todayUsd: number;
  last30Usd: number;
  byDay: { day: string; usd: number }[];
  byFeature: Record<string, number>;
  byModel: Record<string, number>;
  cacheHitRate: number; // share of input tokens served from cache
}

export async function usageSummary(now = new Date(), days = 30): Promise<UsageSummary> {
  const cutoff = now.getTime() - days * 86_400_000;
  const recent = (await readRecords()).filter((r) => new Date(r.at).getTime() >= cutoff);
  const today = localDay(now.toISOString());
  const byDay = new Map<string, number>();
  const byFeature: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let read = 0;
  let totalIn = 0;
  for (const r of recent) {
    const d = localDay(r.at);
    byDay.set(d, (byDay.get(d) ?? 0) + r.usd);
    byFeature[r.feature] = (byFeature[r.feature] ?? 0) + r.usd;
    byModel[r.model] = (byModel[r.model] ?? 0) + r.usd;
    read += r.cacheRead;
    totalIn += r.input + r.cacheRead + r.cacheWrite;
  }
  return {
    todayUsd: byDay.get(today) ?? 0,
    last30Usd: recent.reduce((s, r) => s + r.usd, 0),
    byDay: [...byDay.entries()].sort().map(([day, usd]) => ({ day, usd })),
    byFeature,
    byModel,
    cacheHitRate: totalIn ? read / totalIn : 0,
  };
}

export async function spentToday(now = new Date()): Promise<number> {
  return (await usageSummary(now, 1)).todayUsd;
}

const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** usage_report tool. */
export async function usageReport(): Promise<string> {
  const s = await usageSummary();
  if (s.last30Usd === 0) return "No Claude API usage recorded yet.";
  const features = Object.entries(s.byFeature)
    .sort((a, b) => b[1] - a[1])
    .map(([f, usd]) => `${f} ${money(usd)}`)
    .join(", ");
  return `Today: ${money(s.todayUsd)}. Last 30 days: ${money(s.last30Usd)} (${features}). ${Math.round(s.cacheHitRate * 100)}% of input came from the prompt cache.`;
}
