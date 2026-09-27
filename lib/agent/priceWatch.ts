import { randomUUID } from "node:crypto";
import { claudeJson } from "./claudeJson";
import { jsonStore } from "./jsonStore";
import { money } from "./financeTools";

// Price watch: "tell me when this drops below ₹20,000". ULTRON checks the
// product page a few times a day and speaks up once the price is at or under
// the target (and again only if it falls a further 5%).

const CHECK_EVERY_MS = 6 * 60 * 60_000;
const MAX_WATCHES = 25;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export interface Watch {
  id: string;
  url: string;
  title: string;
  target: number;
  price?: number;
  lowest?: number;
  notifiedAt?: number;
  notifiedPrice?: number;
  checkedAt?: number;
  error?: string;
  addedAt: string;
}

interface Store {
  watches: Watch[];
}
const store = jsonStore<Store>("price-watch.json", () => ({ watches: [] }));

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

/** The product's name and price from its page, without a model when possible. */
export function extractFromHtml(html: string): { title: string; price?: number } {
  const title = decode(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ?? /<title[^>]*>([^<]+)/i.exec(html)?.[1] ?? "",
  ).slice(0, 120);
  // 1. Structured data (most shops): offers.price / lowPrice.
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found: number[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== "object") return;
        const o = v as Record<string, unknown>;
        if (/offer/i.test(String(o["@type"] ?? "")) || "priceCurrency" in o) {
          const p = num(o.price) ?? num(o.lowPrice);
          if (p) found.push(p);
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1]));
      if (found.length) return { title, price: Math.min(...found) };
    } catch {
      // malformed block — try the next
    }
  }
  // 2. Meta tags.
  const meta = /<meta[^>]+(?:property|itemprop|name)=["'](?:product:price:amount|og:price:amount|price)["'][^>]+content=["']([^"']+)/i.exec(html)?.[1];
  if (num(meta)) return { title, price: num(meta) };
  // 3. Amazon's price block.
  const amazon = /class=["']a-price-whole["'][^>]*>([\d,]+)/i.exec(html)?.[1];
  if (num(amazon)) return { title, price: num(amazon) };
  return { title };
}

export interface PriceDeps {
  fetchHtml: (url: string) => Promise<string>;
  /** Last resort: a model reads the visible text. */
  readPrice: (text: string) => Promise<number | undefined>;
  now: () => number;
}

export const defaultPriceDeps: PriceDeps = {
  fetchHtml: async (url) => {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9", Accept: "text/html" }, redirect: "follow" });
    if (!res.ok) throw new Error(`The shop's page answered ${res.status}.`);
    return (await res.text()).slice(0, 3_000_000);
  },
  readPrice: async (text) => {
    const r = await claudeJson<{ found: boolean; price: number }>({
      model: "claude-haiku-4-5",
      system: "Find the current selling price of the main product on this shop page (the price a buyer pays now, not the MRP or a strike-through price).",
      content: text.slice(0, 8000),
      schema: { type: "object", properties: { found: { type: "boolean" }, price: { type: "number" } }, required: ["found", "price"], additionalProperties: false },
      usage: "prices",
      maxTokens: 200,
    });
    return r.found ? num(r.price) : undefined;
  },
  now: () => Date.now(),
};

export async function priceOf(url: string, deps: PriceDeps = defaultPriceDeps): Promise<{ title: string; price: number }> {
  const html = await deps.fetchHtml(url);
  let { title, price } = extractFromHtml(html);
  if (!price) {
    const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
    if (/captcha|robot check|access denied/i.test(text.slice(0, 3000))) throw new Error("The shop blocked the automatic check (a robot check).");
    price = await deps.readPrice(text);
  }
  if (!price) throw new Error("Couldn't find a price on that page.");
  return { title: title || new URL(url).hostname, price };
}

function checkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error("I need the product's link (copy it from the browser or the shopping app's Share button).");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("That isn't a web link.");
  // Only public shop pages — never this PC or the home network.
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i.test(u.hostname)) throw new Error("That isn't a shop's page.");
  return u.toString();
}

/** watch_price tool. */
export async function watchPrice(url: string, target: number, deps: PriceDeps = defaultPriceDeps): Promise<string> {
  if (!(target > 0)) throw new Error("Give the price to wait for, e.g. 20000.");
  const clean = checkUrl(url);
  const { title, price } = await priceOf(clean, deps);
  const now = deps.now();
  await store.update((s) => {
    s.watches = s.watches.filter((w) => w.url !== clean);
    if (s.watches.length >= MAX_WATCHES) throw new Error(`Already watching ${MAX_WATCHES} prices — stop one first.`);
    s.watches.push({ id: randomUUID().slice(0, 6), url: clean, title, target, price, lowest: price, checkedAt: now, addedAt: new Date(now).toISOString() });
  });
  return price <= target
    ? `${title} is already ${money(price)} — at or below your ${money(target)}. I'll keep an eye on it anyway.`
    : `Watching ${title}: now ${money(price)}. I'll tell you when it's ${money(target)} or less.`;
}

function findWatch(watches: Watch[], which: string): Watch {
  const w = which.trim().toLowerCase();
  const hit = watches.find((x) => x.id === w) ?? watches.find((x) => x.title.toLowerCase().includes(w) || x.url.toLowerCase().includes(w));
  if (!hit) throw new Error(`No price watch matches "${which}".`);
  return hit;
}

export async function listPriceWatches(): Promise<string> {
  const { watches } = await store.read();
  if (!watches.length) return "No prices are being watched.";
  return watches
    .map((w) => `[${w.id}] ${w.title}: ${w.price ? money(w.price) : "price unknown"} (target ${money(w.target)}${w.lowest ? `, lowest seen ${money(w.lowest)}` : ""})${w.error ? ` — last check failed: ${w.error}` : ""}`)
    .join("\n");
}

export async function stopPriceWatch(which: string): Promise<string> {
  return store.update((s) => {
    const w = findWatch(s.watches, which);
    s.watches = s.watches.filter((x) => x !== w);
    return `Stopped watching ${w.title}.`;
  });
}

/** Background: checks watches that are due; returns what to announce. */
export async function checkPrices(deps: PriceDeps = defaultPriceDeps): Promise<string[]> {
  const now = deps.now();
  const due = (await store.read()).watches.filter((w) => !w.checkedAt || now - w.checkedAt >= CHECK_EVERY_MS);
  const out: string[] = [];
  for (const d of due) {
    let price: number | undefined;
    let error: string | undefined;
    try {
      price = (await priceOf(d.url, deps)).price;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await store.update((s) => {
      const w = s.watches.find((x) => x.id === d.id);
      if (!w) return;
      w.checkedAt = now;
      w.error = error;
      if (price === undefined) return;
      w.price = price;
      w.lowest = Math.min(w.lowest ?? price, price);
      const hit = price <= w.target;
      const furtherDrop = w.notifiedPrice !== undefined && price <= w.notifiedPrice * 0.95;
      if (hit && (w.notifiedPrice === undefined || furtherDrop)) {
        w.notifiedAt = now;
        w.notifiedPrice = price;
        out.push(`Sir, ${w.title} is down to ${money(price)} — ${furtherDrop ? "even lower than when I last told you" : `at or below your ${money(w.target)}`}.`);
      }
      if (!hit) w.notifiedPrice = undefined; // back up: tell again when it next drops
    });
  }
  return out;
}
