"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { downsample, encodeWav } from "@/lib/audio";

interface Settings {
  advisor: boolean;
  backgroundSpeech: boolean;
  backgroundNotifications: boolean;
  sttEngine: "browser" | "whisper";
  sttLanguage: "en" | "hi" | "auto";
  computerUse: boolean;
  telegramNotifications: boolean;
  dailyBudgetUsd: number;
  voice: string;
  voiceSpeed: number;
  hotkey: string;
  voiceLock: boolean;
  voiceLockThreshold: number;
  webcamPresence: boolean;
  presenceLockMinutes: number;
  screenTime: boolean;
  stockWatchlist: string[];
  newsInBriefing: boolean;
  billReminders: boolean;
}

interface Snapshot {
  settings: Settings;
  facts: { text: string; savedAt: string }[];
  episodes: { id: string; at: string; summary: string; mood?: string }[];
  reminders: { items: { id: string; kind: string; text: string; dueAt: string }[]; briefingTime: string | null };
  proactive: { enabled: boolean; quietStart: string | null; quietEnd: string | null };
  usage: {
    todayUsd: number;
    last30Usd: number;
    byDay: { day: string; usd: number }[];
    byFeature: Record<string, number>;
    byModel: Record<string, number>;
    cacheHitRate: number;
  };
  routines: { id: string; name: string; steps: string[]; schedule: string | null }[];
  voices: string[];
  voiceId: { enrolled: boolean; clips: number; whisperInstalled: boolean };
  integrations: { google: boolean; homeAssistant: boolean; smartLife: boolean; tv: string | null; telegram: boolean; homeLocation: string | null };
}

const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="set-row">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const ENROLL_PHRASES = [
  "Hey ULTRON, what's the weather like today and do I need an umbrella?",
  "Turn off the lights in the bedroom and set an alarm for seven in the morning.",
  "Remind me to call my mother this evening after I get back from work.",
  "Play some relaxing music and lower the volume a little bit, please.",
];

/** Records a few seconds from the mic as a 16 kHz WAV (voice-lock enrollment). */
async function recordClip(seconds: number): Promise<Uint8Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(ctx.destination);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  node.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  const rate = ctx.sampleRate;
  await ctx.close();
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return encodeWav(downsample(all, rate));
}

export default function SettingsPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [newFact, setNewFact] = useState("");
  const [quiet, setQuiet] = useState("");
  const [briefing, setBriefing] = useState("");
  const [hotkey, setHotkey] = useState("");
  const [stocks, setStocks] = useState("");
  const [recording, setRecording] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return setError(`Couldn't load settings (${res.status}).`);
    const d = (await res.json()) as Snapshot;
    setData(d);
    setQuiet(d.proactive.quietStart ? `${d.proactive.quietStart}-${d.proactive.quietEnd}` : "off");
    setBriefing(d.reminders.briefingTime ?? "");
    setHotkey(d.settings.hotkey);
    setStocks(d.settings.stockWatchlist.join(", "));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (body: object) => {
    setError("");
    const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) return setError(d.error ?? "Something went wrong.");
    setData(d as Snapshot);
  }, []);

  const update = (patch: Partial<Settings>) => act({ action: "update", settings: patch });

  const testVoice = async () => {
    setError("");
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Good evening, sir. All systems are online and ready." }),
    });
    if (!res.ok) return setError("No voice engine answered — install Piper (see README).");
    void new Audio(URL.createObjectURL(await res.blob())).play();
  };

  const enroll = async (reset = false) => {
    setError("");
    try {
      if (reset) {
        await fetch("/api/voiceid?action=reset", { method: "POST" });
        await load();
        return;
      }
      const phrase = ENROLL_PHRASES[(data?.voiceId.clips ?? 0) % ENROLL_PHRASES.length];
      setRecording(phrase);
      const wav = await recordClip(5);
      setRecording(null);
      const res = await fetch("/api/voiceid?action=enroll", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav as unknown as BodyInit });
      const d = await res.json();
      if (!res.ok) setError(d.error ?? "Couldn't use that recording.");
      await load();
    } catch (err) {
      setRecording(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!data) {
    return <main className="settings-page">{error || "Loading…"}</main>;
  }
  const s = data.settings;
  const maxDay = Math.max(0.0001, ...data.usage.byDay.map((d) => d.usd));

  return (
    <main className="settings-page">
      <header className="set-header">
        <h1>U.L.T.R.O.N. — SETTINGS</h1>
        <Link href="/" className="hud-btn">
          ← BACK
        </Link>
      </header>
      {error && <p className="set-error">{error}</p>}

      <section>
        <h2>Brain &amp; abilities</h2>
        <Toggle label="Think harder on hard questions" hint="Consults Claude Opus 5 before answering. Slower and pricier, only when needed." checked={s.advisor} onChange={(v) => update({ advisor: v })} />
        <Toggle label="Allow operating the computer" hint="Clicking and typing for you. Every task still asks you first." checked={s.computerUse} onChange={(v) => update({ computerUse: v })} />
        <label className="set-row">
          <span>
            Daily spending cap
            <small>ULTRON stops answering for the day once reached. 0 = no cap.</small>
          </span>
          <input
            type="number"
            min={0}
            step={0.5}
            defaultValue={s.dailyBudgetUsd}
            onBlur={(e) => update({ dailyBudgetUsd: Number(e.target.value) })}
          />
        </label>
      </section>

      <section>
        <h2>Hearing</h2>
        <label className="set-row">
          <span>
            Speech recognition
            <small>Whisper runs on this PC — more accurate, works offline, understands Hindi. Needs scripts\install-whisper.ps1.</small>
          </span>
          <select value={s.sttEngine} onChange={(e) => update({ sttEngine: e.target.value as Settings["sttEngine"] })}>
            <option value="browser">Browser (Chrome)</option>
            <option value="whisper">Whisper (local)</option>
          </select>
        </label>
        <label className="set-row">
          <span>Language</span>
          <select value={s.sttLanguage} onChange={(e) => update({ sttLanguage: e.target.value as Settings["sttLanguage"] })}>
            <option value="en">English</option>
            <option value="hi">Hindi</option>
            <option value="auto">Auto / Hinglish (Whisper only)</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Voice</h2>
        <label className="set-row">
          <span>
            ULTRON&apos;s voice
            <small>More voices: scripts\install-piper-voice.ps1 butler (or jarvis, us-male, us-female, uk-female, narrator).</small>
          </span>
          <select value={s.voice} onChange={(e) => update({ voice: e.target.value })}>
            <option value="">Default</option>
            {data.voices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="set-row">
          <span>
            Speaking speed <small>{s.voiceSpeed.toFixed(2)}×</small>
          </span>
          <input type="range" min={0.7} max={1.5} step={0.05} defaultValue={s.voiceSpeed} onMouseUp={(e) => update({ voiceSpeed: Number((e.target as HTMLInputElement).value) })} onTouchEnd={(e) => update({ voiceSpeed: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => update({ voiceSpeed: Number((e.target as HTMLInputElement).value) })} />
        </label>
        <button className="hud-btn" onClick={() => void testVoice()}>
          TEST VOICE
        </button>
      </section>

      <section>
        <h2>Push-to-talk &amp; voice lock</h2>
        <label className="set-row">
          <span>
            Push-to-talk hotkey
            <small>Works from any app, even with ULTRON minimised. Empty = off.</small>
          </span>
          <input value={hotkey} placeholder="Ctrl+Shift+Space" onChange={(e) => setHotkey(e.target.value)} onBlur={() => update({ hotkey })} />
        </label>
        <Toggle
          label="Only obey my voice"
          hint={data.voiceId.whisperInstalled ? "Ignores other people, the TV and videos. Needs your voice recorded below." : "Needs local Whisper (scripts\\install-whisper.ps1)."}
          checked={s.voiceLock}
          onChange={(v) => update({ voiceLock: v })}
        />
        <div className="set-row">
          <span>
            Your voice: {data.voiceId.enrolled ? `learned (${data.voiceId.clips} recordings)` : `${data.voiceId.clips} of 3 recordings`}
            <small>{recording ? `Recording — read aloud: "${recording}"` : "Each recording is 5 seconds; read the sentence shown."}</small>
          </span>
          <span>
            <button className="hud-btn" disabled={Boolean(recording)} onClick={() => void enroll()}>
              {recording ? "LISTENING…" : "RECORD"}
            </button>{" "}
            {data.voiceId.clips > 0 && (
              <button className="hud-btn" onClick={() => void enroll(true)}>
                RESET
              </button>
            )}
          </span>
        </div>
        <label className="set-row">
          <span>
            Voice lock strictness <small>{s.voiceLockThreshold.toFixed(2)} — raise it if others get through, lower it if you&apos;re ignored.</small>
          </span>
          <input type="range" min={0.3} max={0.8} step={0.05} defaultValue={s.voiceLockThreshold} onMouseUp={(e) => update({ voiceLockThreshold: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => update({ voiceLockThreshold: Number((e.target as HTMLInputElement).value) })} />
        </label>
      </section>

      <section>
        <h2>Webcam presence</h2>
        <Toggle label="Notice when I sit down and leave" hint="Face detection in the browser — video never leaves this PC. Works in the ULTRON tab on this PC." checked={s.webcamPresence} onChange={(v) => update({ webcamPresence: v })} />
        <label className="set-row">
          <span>
            Lock the PC when I&apos;m away for
            <small>Minutes; 0 = never.</small>
          </span>
          <input type="number" min={0} max={120} defaultValue={s.presenceLockMinutes} onBlur={(e) => update({ presenceLockMinutes: Number(e.target.value) })} />
        </label>
      </section>

      <section>
        <h2>Everyday help</h2>
        <Toggle label="Record screen time" hint="Which apps you use, kept on this PC (app names only)." checked={s.screenTime} onChange={(v) => update({ screenTime: v })} />
        <Toggle label="Remind me about bills" hint="Checks Gmail once a day and reminds you 2 days before each due date." checked={s.billReminders} onChange={(v) => update({ billReminders: v })} />
        <Toggle label="Headlines in the morning briefing" checked={s.newsInBriefing} onChange={(v) => update({ newsInBriefing: v })} />
        <label className="set-row">
          <span>
            Stocks in the morning briefing
            <small>Tickers, comma-separated — e.g. RELIANCE.NS, TCS.NS, ^NSEI</small>
          </span>
          <input
            value={stocks}
            onChange={(e) => setStocks(e.target.value)}
            onBlur={() => update({ stockWatchlist: stocks.split(",").map((x) => x.trim()).filter(Boolean) })}
          />
        </label>
      </section>

      <section>
        <h2>Routines ({data.routines.length})</h2>
        {data.routines.length === 0 && <p className="set-empty">None yet — say &quot;when I say good night, turn off the lights and the TV&quot;.</p>}
        {data.routines.map((r) => (
          <div key={r.id} className="set-item">
            <span>
              <b>{r.name}</b> {r.steps.join(" → ")} {r.schedule && <small>runs {r.schedule}</small>}
            </span>
            <button className="hud-btn" onClick={() => act({ action: "delete_routine", id: r.id })}>
              DELETE
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2>When the page is closed</h2>
        <Toggle label="Speak reminders and notices out loud" checked={s.backgroundSpeech} onChange={(v) => update({ backgroundSpeech: v })} />
        <Toggle label="Show Windows notifications" checked={s.backgroundNotifications} onChange={(v) => update({ backgroundNotifications: v })} />
        <Toggle label="Also send them to my Telegram" hint="Needs the Telegram bot set up." checked={s.telegramNotifications} onChange={(v) => update({ telegramNotifications: v })} />
      </section>

      <section>
        <h2>Speaking up on its own</h2>
        <Toggle label="Proactive notices" hint="Meeting soon, important email, low disk, rain." checked={data.proactive.enabled} onChange={(v) => act({ action: "proactive", enabled: v })} />
        <label className="set-row">
          <span>
            Quiet hours
            <small>Like 22:00-07:00, or &quot;off&quot;.</small>
          </span>
          <input value={quiet} onChange={(e) => setQuiet(e.target.value)} onBlur={() => act({ action: "proactive", quietHours: quiet })} />
        </label>
        <label className="set-row">
          <span>
            Daily morning briefing
            <small>24-hour time, or empty for off.</small>
          </span>
          <input value={briefing} placeholder="07:30" onChange={(e) => setBriefing(e.target.value)} onBlur={() => act({ action: "briefing", time: briefing || "off" })} />
        </label>
      </section>

      <section>
        <h2>Timers &amp; reminders ({data.reminders.items.length})</h2>
        {data.reminders.items.length === 0 && <p className="set-empty">Nothing scheduled.</p>}
        {data.reminders.items.map((r) => (
          <div key={r.id} className="set-item">
            <span>
              <b>{r.kind}</b> {r.text} <small>{when(r.dueAt)}</small>
            </span>
            <button className="hud-btn" onClick={() => act({ action: "cancel_reminder", id: r.id })}>
              CANCEL
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2>What ULTRON remembers about you ({data.facts.length})</h2>
        <div className="set-item">
          <input value={newFact} placeholder="Add something it should know…" onChange={(e) => setNewFact(e.target.value)} />
          <button
            className="hud-btn"
            onClick={() => {
              if (newFact.trim()) void act({ action: "add_fact", text: newFact }).then(() => setNewFact(""));
            }}
          >
            ADD
          </button>
        </div>
        {[...data.facts].reverse().map((f) => (
          <div key={f.savedAt + f.text} className="set-item">
            <span>
              {f.text} <small>{when(f.savedAt)}</small>
            </span>
            <button className="hud-btn" onClick={() => act({ action: "delete_fact", text: f.text })}>
              FORGET
            </button>
          </div>
        ))}
        {data.facts.length > 0 && (
          <button
            className="hud-btn set-danger"
            onClick={() => {
              if (confirm("Forget everything ULTRON has learned about you?")) void act({ action: "clear_facts" });
            }}
          >
            FORGET EVERYTHING
          </button>
        )}
      </section>

      <section>
        <h2>Past conversations ({data.episodes.length})</h2>
        {data.episodes.length === 0 && <p className="set-empty">None yet — they&apos;re saved when a conversation ends.</p>}
        {data.episodes.slice(0, 50).map((e) => (
          <div key={e.id} className="set-item">
            <span>
              {e.summary} {e.mood && <i>({e.mood})</i>} <small>{when(e.at)}</small>
            </span>
            <button className="hud-btn" onClick={() => act({ action: "delete_episode", id: e.id })}>
              DELETE
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2>Claude API spending</h2>
        <p>
          Today <b>{money(data.usage.todayUsd)}</b> · last 30 days <b>{money(data.usage.last30Usd)}</b> · {Math.round(data.usage.cacheHitRate * 100)}% of
          input served from cache
        </p>
        {data.usage.byDay.length > 0 && (
          <div className="set-bars" aria-label="Spending per day">
            {data.usage.byDay.map((d) => (
              <div key={d.day} title={`${d.day}: ${money(d.usd)}`} style={{ height: `${Math.max(2, (d.usd / maxDay) * 100)}%` }} />
            ))}
          </div>
        )}
        <p className="set-small">
          By feature: {Object.entries(data.usage.byFeature).map(([k, v]) => `${k} ${money(v)}`).join(" · ") || "—"}
          <br />
          By model: {Object.entries(data.usage.byModel).map(([k, v]) => `${k} ${money(v)}`).join(" · ") || "—"}
        </p>
      </section>

      <section>
        <h2>Connections</h2>
        <p className="set-small">
          Google: {data.integrations.google ? "configured — connect at " : "not configured (.env.local)"}
          {data.integrations.google && <a href="/api/gmail/auth">/api/gmail/auth</a>}
          <br />
          Smart Life lights &amp; plugs: {data.integrations.smartLife ? "configured" : "not configured (TUYA_ACCESS_ID / TUYA_ACCESS_SECRET)"}
          <br />
          TV: {data.integrations.tv ? `configured (${data.integrations.tv})` : "not configured (ANDROID_TV_HOST)"}
          <br />
          Home Assistant: {data.integrations.homeAssistant ? "configured" : "not configured (HOME_ASSISTANT_URL / HOME_ASSISTANT_TOKEN)"}
          <br />
          Telegram: {data.integrations.telegram ? "configured" : "not configured (TELEGRAM_BOT_TOKEN)"}
          <br />
          Home location: {data.integrations.homeLocation ?? "not set (ULTRON_HOME_LOCATION)"}
        </p>
      </section>
    </main>
  );
}
