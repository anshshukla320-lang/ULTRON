import "./tempHome";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetTuyaState } from "../lib/agent/tuya";
import { irControl, nextAcState, pickKey, resetIrState } from "../lib/agent/tuyaIr";
import { distractionNudge, focusStatus, startFocus, stopFocus, takeFocusDue } from "../lib/agent/focus";
import { appLabel, recordSample, resetScreenTimeClock, screenTimeReport } from "../lib/agent/screenTime";
import { formatQuote, getCricketScores, getNews, getStockPrices, parseRss } from "../lib/agent/liveInfo";
import { scanBills, type BillDeps } from "../lib/agent/bills";
import { parseClipboardOutput } from "../lib/agent/clipboard";
import { parseHelperLine, parseHotkey } from "../lib/agent/desktopHelper";
import { cosine, scoreAgainst, wavToSamples } from "../lib/agent/voiceId";
import { encodeWav } from "../lib/audio";
import { PresenceTracker } from "../lib/presenceTracker";
import { getSettings, updateSettings } from "../lib/agent/settings";
import { lengthScaleFor } from "../lib/agent/piperTts";

test("IR blaster: fan buttons and AC scenes through Tuya's IR API", async (t) => {
  resetTuyaState();
  resetIrState();
  process.env.TUYA_ACCESS_ID = "id";
  process.env.TUYA_ACCESS_SECRET = "secret";
  const calls: { method: string; path: string; body?: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, body: init.body ? JSON.parse(init.body as string) : undefined });
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (u.pathname === "/v1.0/token") return ok({ access_token: "tok", expire_time: 7200 });
    if (u.pathname === "/v1.0/iot-01/associated-users/devices") {
      return ok({ devices: [{ id: "hub1", name: "IR Blaster", category: "wnykq", online: true, status: [] }], has_more: false });
    }
    if (u.pathname === "/v1.0/infrareds/hub1/remotes") {
      return ok([
        { remote_id: "ac1", remote_name: "Bedroom AC", category_id: "5" },
        { remote_id: "fan1", remote_name: "Ceiling Fan", category_id: "8" },
      ]);
    }
    if (u.pathname === "/v1.0/infrareds/hub1/remotes/fan1/keys") {
      return ok({ key_list: [{ key: "power", key_id: 1, key_name: "Power" }, { key: "speed_up", key_id: 2, key_name: "Speed+" }, { key: "shake", key_id: 3, key_name: "Swing" }] });
    }
    return ok(true);
  });

  assert.match(await irControl({ remote: "ceiling fan", key: "faster" }), /Pressed Speed\+ on the Ceiling Fan remote/);
  assert.deepEqual(calls.at(-1), { method: "POST", path: "/v1.0/infrareds/hub1/remotes/fan1/command", body: { key: "speed_up" } });
  assert.match(await irControl({ remote: "fan", key: "on" }), /Power.*can't tell whether it was on/);
  await assert.rejects(irControl({ remote: "fan", key: "rainbow mode" }), /no "rainbow mode" button. Buttons: Power, Speed\+, Swing/);

  assert.equal(await irControl({ remote: "the AC", temperature: 22, mode: "cool" }), "Bedroom AC: on, cool, 22°C, fan auto.");
  assert.deepEqual(calls.at(-1), { method: "POST", path: "/v2.0/infrareds/hub1/air-conditioners/ac1/scenes/command", body: { power: 1, mode: 0, temp: 22, wind: 0 } });
  assert.equal(await irControl({ remote: "bedroom ac", fan_speed: "high" }), "Bedroom AC: on, cool, 22°C, fan high.", "remembers the last setting");
  assert.equal(await irControl({ remote: "bedroom ac", key: "off" }), "Bedroom AC is off.");
  await assert.rejects(irControl({ remote: "kitchen" }), /No IR remote called "kitchen". Remotes: Bedroom AC, Ceiling Fan/);

  assert.equal(nextAcState({ power: 0, mode: 0, temp: 24, wind: 0 }, { temperature: 40 }).temp, 30, "clamped to what ACs accept");
  assert.throws(() => nextAcState({ power: 0, mode: 0, temp: 24, wind: 0 }, { mode: "arctic" }), /AC mode/);
  assert.equal(pickKey([{ key: "vol_up", key_id: 1, key_name: "Volume +" }, { key: "power", key_id: 2, key_name: "Power" }], "volume up")?.key, "vol_up");
});

beforeEach(async () => {
  await fs.rm(path.join(os.homedir(), ".ultron", "focus.json"), { force: true });
});

test("focus mode: rounds, breaks, and distraction nudges", async () => {
  const t0 = Date.UTC(2026, 8, 26, 10, 0);
  assert.match(await startFocus({ minutes: 25, breakMinutes: 5, rounds: 2, task: "the report" }, t0), /25 minutes, then 5-minute breaks, 2 rounds on the report/);
  assert.deepEqual(await takeFocusDue(t0 + 10 * 60_000), []);
  assert.match(await focusStatus(t0 + 10 * 60_000), /Focusing, round 1 of 2 — 15 min left/);

  const yt = { process: "chrome", title: "lofi beats - YouTube - Google Chrome", idleMs: 0 };
  assert.match((await distractionNudge(yt, t0 + 11 * 60_000))!, /that's YouTube — you're meant to be focusing on the report. 14 minutes to go/);
  assert.equal(await distractionNudge(yt, t0 + 12 * 60_000), null, "not nagging every sample");
  assert.equal(await distractionNudge({ process: "Code", title: "report.md", idleMs: 0 }, t0 + 20 * 60_000), null);

  assert.match((await takeFocusDue(t0 + 25 * 60_000))[0].text, /Round 1 done, sir. Take a 5-minute break/);
  assert.equal(await distractionNudge(yt, t0 + 26 * 60_000), null, "YouTube on a break is fine");
  assert.match((await takeFocusDue(t0 + 30 * 60_000))[0].text, /Round 2 of 2 — 25 minutes/);
  assert.match((await takeFocusDue(t0 + 55 * 60_000))[0].text, /end of your focus session — all 2 rounds done/);
  assert.equal(await focusStatus(), "Focus mode is off.");
  assert.equal(await stopFocus(), "Focus mode wasn't on.");
});

test("screen time: counts active time per app, never idle time", async () => {
  resetScreenTimeClock();
  assert.equal(appLabel({ process: "chrome", title: "Home / X" }), "X / Twitter (Chrome)");
  assert.equal(appLabel({ process: "msedge", title: "Instagram" }), "Instagram (Edge)");
  assert.equal(appLabel({ process: "Code", title: "anything" }), "VS Code");
  assert.equal(appLabel({ process: "SomeGame", title: "" }), "SomeGame");

  const base = new Date(2026, 8, 20, 9, 0, 0);
  const at = (s: number) => new Date(base.getTime() + s * 1000);
  await recordSample({ process: "Code", title: "x", idleMs: 0 }, at(0)); // first sample: starts the clock
  for (let s = 15; s <= 600; s += 15) await recordSample({ process: "Code", title: "x", idleMs: 0 }, at(s));
  for (let s = 615; s <= 900; s += 15) await recordSample({ process: "chrome", title: "cats - YouTube", idleMs: 1000 }, at(s));
  for (let s = 915; s <= 1800; s += 15) await recordSample({ process: "chrome", title: "cats - YouTube", idleMs: 5 * 60_000 }, at(s)); // walked away
  await recordSample({ process: "Code", title: "x", idleMs: 0 }, at(4000)); // after a long gap: at most 30 s counted
  const report = await screenTimeReport("today", base);
  // 600 s of VS Code + the capped 30 s after the long gap; 300 s of YouTube; idle time not counted.
  assert.match(report, /Screen time today: 16 min in total/);
  assert.match(report, /VS Code: 11 min\nYouTube \(Chrome\): 5 min/);
  assert.match(await screenTimeReport("yesterday", base), /No screen time recorded for yesterday/);
});

test("live info: RSS, quotes, and fallbacks", async (t) => {
  const rss = `<rss><channel><item><title><![CDATA[Monsoon to withdraw early &amp; fast - The Hindu]]></title><source url="x">The Hindu</source><pubDate>Sat, 26 Sep 2026 09:00:00 GMT</pubDate></item><item><title>No source here</title></item></channel></rss>`;
  const items = parseRss(rss);
  assert.equal(items[0].title, "Monsoon to withdraw early & fast - The Hindu");
  assert.equal(items[0].source, "The Hindu");
  assert.equal(items.length, 2);

  assert.equal(
    formatQuote({ symbol: "RELIANCE.NS", shortName: "RELIANCE INDUSTRIES", currency: "INR", regularMarketPrice: 2950.5, chartPreviousClose: 2900 }),
    "RELIANCE INDUSTRIES (RELIANCE.NS): ₹2950.50, up 1.74% (+₹50.50)",
  );

  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    if (url.includes("news.google.com")) return new Response(rss);
    if (url.includes("/v1/finance/search")) return Response.json({ quotes: [{ symbol: "TTM", quoteType: "EQUITY" }, { symbol: "TATAMOTORS.NS", quoteType: "EQUITY" }] });
    if (url.includes("/v8/finance/chart/")) {
      const sym = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
      return Response.json({ chart: { result: [{ meta: { symbol: sym, currency: "INR", regularMarketPrice: 100, chartPreviousClose: 101, marketState: "CLOSED" } }] } });
    }
    if (url.includes("cricinfo")) return new Response("", { status: 503 });
    return new Response("nope", { status: 404 });
  });
  assert.match(await getNews(), /• Monsoon to withdraw early & fast — The Hindu/);
  const prices = await getStockPrices("tata motors, nifty");
  assert.match(prices, /TATAMOTORS\.NS: ₹100\.00, down 0\.99% \(−₹1\.00\) \(market closed\)/, "prefers the NSE listing");
  assert.match(prices, /\^NSEI/);
  assert.match(await getCricketScores("India"), /Live scores unavailable; latest cricket news/);
  assert.ok(urls.some((u) => u.includes("search?q=India%20cricket%20score")));
});

test("bills: new bills get reminders once; receipts, past dues and duplicates don't", async () => {
  const reminders: { text: string; at: string }[] = [];
  const read: string[] = [];
  let extractCalls = 0;
  const deps: BillDeps = {
    search: async () => ["m1", "m2", "m3", "m4"],
    read: async (id) => {
      read.push(id);
      return `email ${id}`;
    },
    extract: async () => {
      extractCalls++;
      return [
        { message_id: "m1", is_bill_to_pay: true, biller: "Tata Power electricity", amount: "₹1,245.00", due_date: "2026-10-05" },
        { message_id: "m2", is_bill_to_pay: false, biller: "Amazon", amount: "₹499", due_date: "" },
        { message_id: "m3", is_bill_to_pay: true, biller: "Airtel", amount: "₹799", due_date: "2026-09-01" },
        { message_id: "m4", is_bill_to_pay: true, biller: "Tata Power Electricity", amount: "₹1,245.00", due_date: "2026-10-05" },
      ];
    },
    remind: async (text, at) => void reminders.push({ text, at }),
  };
  const now = new Date(2026, 8, 26, 10, 0);
  const fresh = await scanBills(now, deps);
  assert.deepEqual(fresh.map((b) => b.biller), ["Tata Power electricity"]);
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].text, /your Tata Power electricity bill of ₹1,245.00 is due/);
  assert.equal(new Date(reminders[0].at).getDate(), 3, "two days before the 5th");

  assert.deepEqual(await scanBills(now, deps), [], "nothing new the second time");
  assert.equal(extractCalls, 1, "already-seen emails aren't sent to Claude again");
  assert.equal(read.length, 4);
});

test("clipboard, hotkeys and the desktop helper protocol", () => {
  assert.deepEqual(parseClipboardOutput("TEXT\r\nline one\r\nline two"), { kind: "text", text: "line one\nline two" });
  assert.deepEqual(parseClipboardOutput("IMAGE 800x600"), { kind: "image", size: "800x600" });
  assert.deepEqual(parseClipboardOutput("FILES\nC:\\a.pdf\n"), { kind: "files", files: ["C:\\a.pdf"] });
  assert.deepEqual(parseClipboardOutput("EMPTY"), { kind: "empty" });

  assert.deepEqual(parseHotkey("Ctrl+Shift+Space"), { mods: 0x2 | 0x4, vk: 0x20 });
  assert.deepEqual(parseHotkey("Win+Alt+U"), { mods: 0x8 | 0x1, vk: 0x55 });
  assert.deepEqual(parseHotkey("F9"), { mods: 0, vk: 0x78 });
  assert.throws(() => parseHotkey("U"), /at least one of Ctrl/);
  assert.throws(() => parseHotkey("Ctrl+Shift"), /needs a normal key/);
  assert.throws(() => parseHotkey("Hyper+U"), /isn't a modifier/);

  assert.deepEqual(parseHelperLine("HOTKEY\r"), { type: "hotkey" });
  assert.deepEqual(parseHelperLine("HOTKEY-TAKEN"), { type: "hotkey-status", status: "taken" });
  assert.deepEqual(parseHelperLine("FG\tchrome\tInbox - Gmail\t1234"), { type: "foreground", process: "chrome", title: "Inbox - Gmail", idleMs: 1234 });
  assert.equal(parseHelperLine("noise"), null);
});

test("voice lock maths", () => {
  const samples = new Float32Array(1600).map((_, i) => Math.sin(i / 5) * 0.5);
  const back = wavToSamples(Buffer.from(encodeWav(samples)));
  assert.equal(back.sampleRate, 16000);
  assert.equal(back.samples.length, 1600);
  assert.ok(Math.abs(back.samples[10] - samples[10]) < 1e-3);
  assert.throws(() => wavToSamples(Buffer.from("not a wav file at all, definitely not")), /Not a WAV/);

  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  const owner = [
    [1, 0.1, 0],
    [0.9, 0.2, 0],
    [1, 0, 0.1],
  ];
  assert.ok(scoreAgainst(owner, [0.95, 0.1, 0.05]) > 0.95);
  assert.ok(scoreAgainst(owner, [0, 0.2, 1]) < 0.3);
});

test("webcam presence: greet only after a real absence", () => {
  const p = new PresenceTracker(3 * 60_000);
  let t = 0;
  const step = (seen: boolean, ms: number) => {
    t += ms;
    return p.update(seen, t);
  };
  assert.deepEqual(step(true, 0), {}, "already there when the page opened — no greeting");
  assert.deepEqual(step(false, 10_000), {}, "glanced away");
  assert.deepEqual(step(true, 5_000), {}, "back within seconds");
  step(false, 25_000); // gone
  const reports: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = step(false, 30_000);
    if (r.away) reports.push(r.away);
  }
  assert.ok(reports.length >= 4 && reports.length <= 6, "about one away report a minute");
  assert.ok(reports.at(-1)! >= 4 * 60_000);
  const back = step(true, 1000);
  assert.ok(back.arrived !== undefined && back.arrived > 5 * 60_000);
});

test("settings: new fields are validated", async () => {
  const s = await updateSettings({
    voice: "en_GB-northern_english_male-medium",
    voiceSpeed: 9,
    stockWatchlist: ["reliance.ns", "bad ticker!", "^NSEI"],
    presenceLockMinutes: -4,
    voiceLockThreshold: 0.1,
    hotkey: "  Ctrl+Alt+J  ",
  });
  assert.equal(s.voice, "en_GB-northern_english_male-medium");
  assert.equal(s.voiceSpeed, 1.5);
  assert.deepEqual(s.stockWatchlist, ["RELIANCE.NS", "^NSEI"]);
  assert.equal(s.presenceLockMinutes, 0);
  assert.equal(s.voiceLockThreshold, 0.3);
  assert.equal(s.hotkey, "Ctrl+Alt+J");
  assert.equal((await updateSettings({ voice: "../../evil" })).voice, "", "only real voice names");
  assert.equal((await getSettings()).screenTime, true);
  assert.equal(lengthScaleFor(1.25), "0.80");
  assert.equal(lengthScaleFor(0.1), "1.43");
});
