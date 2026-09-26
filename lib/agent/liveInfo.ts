// Live info with no API keys: news headlines (Google News RSS), stock
// prices (Yahoo Finance's public chart API) and cricket scores
// (ESPNcricinfo's live-scores feed, with Google News as a fallback).

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ULTRON" };

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}.`);
  return res.text();
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

export interface RssItem {
  title: string;
  source?: string;
  published?: Date;
  link?: string;
}

/** Minimal RSS reader — enough for Google News and Cricinfo feeds. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const tag = (name: string) => {
      const t = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
      return t ? decodeEntities(t[1]) : undefined;
    };
    const title = tag("title");
    if (!title) continue;
    const pub = tag("pubDate");
    const published = pub ? new Date(pub) : undefined;
    items.push({ title, source: tag("source"), published: published && !Number.isNaN(published.getTime()) ? published : undefined, link: tag("link") });
  }
  return items;
}

function ago(d: Date | undefined, now = Date.now()): string {
  if (!d) return "";
  const min = Math.round((now - d.getTime()) / 60_000);
  if (min < 60) return ` (${Math.max(1, min)} min ago)`;
  const h = Math.round(min / 60);
  return h < 48 ? ` (${h} h ago)` : "";
}

/** get_news tool. Google News titles end in " - Source"; that's shown separately. */
export async function getNews(topic = "", count = 6): Promise<string> {
  const region = process.env.ULTRON_NEWS_REGION ?? "IN";
  const params = `hl=en-${region}&gl=${region}&ceid=${region}:en`;
  const url = topic.trim()
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic.trim())}+when:2d&${params}`
    : `https://news.google.com/rss?${params}`;
  const items = parseRss(await getText(url)).slice(0, Math.min(10, Math.max(1, count)));
  if (!items.length) return topic ? `No recent news about "${topic}".` : "No headlines right now.";
  return items
    .map((i) => {
      const source = i.source ?? i.title.match(/ - ([^-]+)$/)?.[1];
      const title = source ? i.title.replace(new RegExp(` - ${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "") : i.title;
      return `• ${title}${source ? ` — ${source}` : ""}${ago(i.published)}`;
    })
    .join("\n");
}

interface ChartMeta {
  symbol: string;
  shortName?: string;
  longName?: string;
  currency?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  marketState?: string;
  regularMarketTime?: number;
}

const CURRENCY_WORD: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export function formatQuote(m: ChartMeta): string {
  const price = m.regularMarketPrice;
  if (price === undefined) return `${m.symbol}: no price available.`;
  const prev = m.chartPreviousClose ?? m.previousClose;
  const sign = CURRENCY_WORD[m.currency ?? ""] ?? `${m.currency ?? ""} `;
  const name = m.shortName ?? m.longName ?? m.symbol;
  let change = "";
  if (prev) {
    const d = price - prev;
    const pct = (d / prev) * 100;
    change = `, ${d >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(2)}% (${d >= 0 ? "+" : "−"}${sign}${Math.abs(d).toFixed(2)})`;
  }
  return `${name === m.symbol ? name : `${name} (${m.symbol})`}: ${sign}${price.toFixed(2)}${change}`;
}

/** Turns "reliance" / "tata motors" / "AAPL" into a ticker. Indian
 *  exchanges are preferred when there's a choice. */
export async function resolveSymbol(query: string): Promise<string> {
  const q = query.trim();
  if (/^[\^A-Z0-9.=-]{1,15}$/.test(q) && (q.includes(".") || q.startsWith("^") || q.length <= 5)) return q;
  const data = JSON.parse(
    await getText(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`),
  ) as { quotes?: { symbol: string; quoteType?: string; exchange?: string }[] };
  const quotes = (data.quotes ?? []).filter((x) => ["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY"].includes(x.quoteType ?? ""));
  const pick = quotes.find((x) => /\.NS$/.test(x.symbol)) ?? quotes.find((x) => /\.BO$/.test(x.symbol)) ?? quotes[0];
  if (!pick) throw new Error(`Couldn't find a stock called "${query}".`);
  return pick.symbol;
}

const INDEX_ALIASES: Record<string, string> = { nifty: "^NSEI", "nifty 50": "^NSEI", sensex: "^BSESN", "bank nifty": "^NSEBANK", "s&p 500": "^GSPC", nasdaq: "^IXIC", dow: "^DJI", "dow jones": "^DJI" };

/** get_stock_price tool — one or several, comma-separated. */
export async function getStockPrices(query: string): Promise<string> {
  const parts = query.split(/,|\band\b/).map((p) => p.trim()).filter(Boolean).slice(0, 8);
  if (!parts.length) throw new Error("Which stock?");
  const lines = await Promise.all(
    parts.map(async (p) => {
      try {
        const symbol = INDEX_ALIASES[p.toLowerCase()] ?? (await resolveSymbol(p));
        const data = JSON.parse(
          await getText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`),
        ) as { chart?: { result?: { meta: ChartMeta }[]; error?: { description?: string } } };
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta) throw new Error(data.chart?.error?.description ?? "no data");
        const closed = meta.marketState && meta.marketState !== "REGULAR" ? " (market closed)" : "";
        return formatQuote(meta) + closed;
      } catch (err) {
        return `${p}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }),
  );
  return lines.join("\n");
}

/** cricket_scores tool. */
export async function getCricketScores(team = ""): Promise<string> {
  const t = team.trim().toLowerCase();
  try {
    const items = parseRss(await getText("https://static.cricinfo.com/rss/livescores.xml"));
    const matches = items.map((i) => i.title).filter((title) => !t || title.toLowerCase().includes(t));
    if (matches.length) {
      // Cricinfo marks the batting side with "*".
      return `Live and recent matches:\n${matches.slice(0, 8).map((m) => `• ${m.replace(/\s+/g, " ")}`).join("\n")}\n(* = batting now)`;
    }
    if (items.length && t) return `No ${team} match on right now.`;
  } catch {
    // feed unavailable — fall back to news
  }
  return `Live scores unavailable; latest cricket news:\n${await getNews(t ? `${team} cricket score` : "cricket live score", 5)}`;
}
