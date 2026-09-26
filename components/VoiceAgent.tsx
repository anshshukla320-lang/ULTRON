"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import { stripSpeechMarkup } from "@/lib/speechSegments";
import { SentenceChunker } from "@/lib/sentenceChunker";
import { SpeechPlayer } from "@/lib/speechPlayer";
import { WhisperRecognizer } from "@/lib/whisperRecognizer";
import { PresenceWatcher } from "@/lib/presenceWatcher";
import { detectWake, isRepeatOf, isStopCommand, leadingWakeCommand, looksLikeEcho, stripLeadingWake } from "@/lib/voiceCommands";

type AgentStatus = "wake" | "listening" | "thinking" | "speaking" | "confirm" | "unsupported";

interface ToolUseRef {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface PendingConfirmation {
  token: string;
  toolUse: ToolUseRef[];
}

interface ActionLogEntry {
  name: string;
  input: unknown;
  output?: string;
  status: "done" | "declined" | "error";
}

// Mirrors AgentEvent in lib/agent/runAgent.ts (one per streamed line).
type AgentEvent =
  | { type: "text"; text: string }
  | { type: "action"; action: ActionLogEntry }
  | { type: "done"; messages: Anthropic.MessageParam[]; reply: string; pending: PendingConfirmation | null }
  | { type: "error"; error: string };

interface DueReminder {
  id: string;
  kind: "timer" | "reminder" | "briefing" | "notice";
  text: string;
}

// Mirrors SpeakingSignals in lib/agent/signals.ts.
interface SpeakingSignals {
  wordsPerSecond?: number;
  interruptedLastReply?: boolean;
  repeatedRequest?: boolean;
  quickFollowUp?: boolean;
}

interface LogEntry {
  id: number;
  kind: "user" | "agent" | "action" | "error";
  text: string;
}

let nextLogId = 1;

// How long ULTRON keeps listening for a follow-up after it finishes
// replying, before requiring the wake word again.
const FOLLOW_UP_WINDOW_MS = 8000;
const REMINDER_POLL_MS = 10_000;
// Right after ULTRON stops talking the mic can still deliver the tail of
// its own voice as a "final" transcript.
const ECHO_GUARD_MS = 4000;

function describeAction(a: ActionLogEntry): string {
  const label = a.name.replace(/_/g, " ");
  if (a.status === "declined") return `✕ declined: ${label}`;
  if (a.status === "error") return `⚠ ${label} failed — ${a.output}`;
  return `✓ ${label}${a.output ? ` — ${a.output}` : ""}`;
}

async function* readEvents(res: Response): AsyncGenerator<AgentEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as AgentEvent;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as AgentEvent;
}

/** A short two-note "I'm listening" sound. */
function playChime(): void {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    });
    setTimeout(() => void ctx.close(), 500);
  } catch {
    // no audio — the status change still shows it
  }
}

export default function VoiceAgent() {
  const [status, setStatus] = useState<AgentStatus>("wake");
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  // Which speech recognizer to use (Settings > Hearing); null until loaded.
  const [stt, setStt] = useState<{
    engine: "browser" | "whisper";
    language: "en" | "hi" | "auto";
    whisperInstalled?: boolean;
    voiceLock?: boolean;
    presence?: { enabled: boolean; lockMinutes: number };
  } | null>(null);

  useEffect(() => {
    fetch("/api/stt")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStt(d ?? { engine: "browser", language: "en" }))
      .catch(() => setStt({ engine: "browser", language: "en" }));
  }, []);

  const messagesRef = useRef<Anthropic.MessageParam[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<AgentStatus>("wake");
  const mutedRef = useRef(false);
  // true = passively waiting to hear "hey ultron"; false = the wake word
  // was just heard alone, so the *next* utterance is the actual command.
  const wakeModeRef = useRef(true);
  // Set synchronously the instant mic permission is denied, so onend can't
  // race the React state update and fire one more restart-retry loop.
  const unsupportedRef = useRef(false);
  // Pending "revert to wake mode" timer for the post-reply follow-up
  // window — cleared the instant a follow-up utterance actually arrives.
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playerRef = useRef<SpeechPlayer | null>(null);
  // Each agent request gets a number; a newer one (or "stop") makes older
  // streams' events irrelevant.
  const turnRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const reminderQueueRef = useRef<DueReminder[]>([]);
  // How the user is speaking — measured per utterance, sent with the next
  // request so ULTRON can match its tone (see lib/agent/signals.ts).
  const utteranceStartRef = useRef<number | null>(null);
  const lastUtteranceRef = useRef("");
  const interruptedRef = useRef(false);
  const signalsRef = useRef<SpeakingSignals>({});
  // Plain transcript of the current conversation, handed to the memory
  // summarizer when the conversation ends.
  const transcriptRef = useRef<Anthropic.MessageParam[]>([]);

  const player = () => (playerRef.current ??= new SpeechPlayer());

  // Speaking speed from Settings, for the browser's fallback voice.
  useEffect(() => {
    fetch("/api/tts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { speed?: number } | null) => {
        if (d?.speed) player().rate = d.speed;
      })
      .catch(() => {});
  }, []);

  const setStatusNow = useCallback((s: AgentStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const pushLog = useCallback((kind: LogEntry["kind"], text: string) => {
    if (!text) return;
    setLog((prev) => [...prev.slice(-49), { id: nextLogId++, kind, text }]);
  }, []);

  const resumeListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || mutedRef.current) return;
    try {
      recognition.start();
    } catch {
      // already running; ignore
    }
  }, []);

  const clearFollowUpTimer = useCallback(() => {
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
  }, []);

  const goIdle = useCallback(() => {
    clearFollowUpTimer();
    wakeModeRef.current = true;
    setStatusNow("wake");
    resumeListening();
  }, [clearFollowUpTimer, setStatusNow, resumeListening]);

  const consolidateConversation = useCallback((viaBeacon = false) => {
    const messages = transcriptRef.current;
    if (!messages.some((m) => m.role === "user")) return;
    transcriptRef.current = [];
    const body = JSON.stringify({ messages });
    if (viaBeacon && navigator.sendBeacon) {
      navigator.sendBeacon("/api/memory/consolidate", new Blob([body], { type: "application/json" }));
    } else {
      void fetch("/api/memory/consolidate", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    }
  }, []);

  // After ULTRON replies, stay in "listening for a follow-up" mode instead
  // of immediately requiring "hey ultron" again — matches the phone call's
  // conversation loop. Reverts to wake mode on its own if nothing is said
  // within the window.
  const armFollowUpWindow = useCallback(() => {
    clearFollowUpTimer();
    wakeModeRef.current = false;
    setStatusNow("listening");
    resumeListening();
    followUpTimerRef.current = setTimeout(() => {
      followUpTimerRef.current = null;
      wakeModeRef.current = true;
      setStatusNow("wake");
      // Nothing more was said: the conversation is over — remember it.
      consolidateConversation();
    }, FOLLOW_UP_WINDOW_MS);
  }, [clearFollowUpTimer, resumeListening, setStatusNow, consolidateConversation]);

  useEffect(() => {
    const onHide = () => consolidateConversation(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [consolidateConversation]);

  /** Cuts off whatever ULTRON is doing: the request in flight and the voice. */
  const interrupt = useCallback(() => {
    turnRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    player().stop();
  }, []);

  const callAgent = useCallback(
    async (resolution?: { token: string; approved: boolean }) => {
      interrupt(); // a new request always supersedes an older one
      const turn = ++turnRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      clearFollowUpTimer();
      setStatusNow("thinking");
      resumeListening(); // off after a confirm box; needed on for "stop"
      const chunker = new SentenceChunker();
      let finalPending: PendingConfirmation | null = null;

      const speakChunk = (chunk: string) => {
        if (!chunk || mutedRef.current) return;
        player().enqueue(chunk);
        if (statusRef.current === "thinking") setStatusNow("speaking");
      };

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: messagesRef.current, resolution, signals: resolution ? undefined : signalsRef.current }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Agent request failed (${res.status}).`);
        }

        for await (const event of readEvents(res)) {
          if (turn !== turnRef.current) return;
          if (event.type === "text") {
            for (const chunk of chunker.push(event.text)) speakChunk(chunk);
          } else if (event.type === "action") {
            pushLog("action", describeAction(event.action));
            transcriptRef.current.push({ role: "assistant", content: `(${event.action.status}: ${event.action.name})` });
          } else if (event.type === "error") {
            throw new Error(event.error);
          } else if (event.type === "done") {
            speakChunk(chunker.flush());
            messagesRef.current = event.messages;
            if (event.reply) {
              pushLog("agent", stripSpeechMarkup(event.reply));
              transcriptRef.current.push({ role: "assistant", content: stripSpeechMarkup(event.reply) });
            }
            finalPending = event.pending;
            setPending(event.pending);
          }
        }
      } catch (err) {
        if (controller.signal.aborted || turn !== turnRef.current) return;
        // A failed confirm (expired/used token) must not leave the modal
        // up with a dead token. The server fills in the unanswered tool
        // call on the next message, so the conversation carries on.
        if (resolution) setPending(null);
        pushLog("error", err instanceof Error ? err.message : String(err));
      }

      await player().whenIdle();
      if (turn !== turnRef.current) return;
      abortRef.current = null;
      if (finalPending) {
        // The mic stays off while the confirm box is up.
        setStatusNow("confirm");
        try {
          recognitionRef.current?.stop();
        } catch {
          // ignore
        }
      } else {
        armFollowUpWindow();
      }
    },
    [interrupt, clearFollowUpTimer, setStatusNow, resumeListening, pushLog, armFollowUpWindow],
  );

  const handleUtterance = useCallback(
    (text: string, measured: { wordsPerSecond?: number } = {}) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const p = playerRef.current;
      signalsRef.current = {
        ...(measured.wordsPerSecond ? { wordsPerSecond: Math.round(measured.wordsPerSecond * 10) / 10 } : {}),
        ...(interruptedRef.current ? { interruptedLastReply: true } : {}),
        ...(isRepeatOf(trimmed, lastUtteranceRef.current) ? { repeatedRequest: true } : {}),
        ...(p && Date.now() - p.lastActiveAt < 1500 ? { quickFollowUp: true } : {}),
      };
      interruptedRef.current = false;
      lastUtteranceRef.current = trimmed;
      transcriptRef.current.push({ role: "user", content: trimmed });
      if (transcriptRef.current.length > 40) consolidateConversation(); // very long session: save as we go
      pushLog("user", trimmed);
      messagesRef.current = [...messagesRef.current, { role: "user", content: trimmed }];
      void callAgent();
    },
    [callAgent, pushLog, consolidateConversation],
  );

  // Reminders are announced only when ULTRON is idle, so they never talk
  // over a reply; anything that comes due mid-conversation waits its turn.
  const announceReminders = useCallback(() => {
    const s = statusRef.current;
    if ((s !== "wake" && s !== "listening") || reminderQueueRef.current.length === 0) return;
    const due = reminderQueueRef.current.shift()!;
    if (due.kind === "briefing") {
      handleUtterance("Give me my morning briefing.");
      return;
    }
    const line =
      due.kind === "timer" ? `Sir, your ${due.text} timer is done.` : due.kind === "notice" ? due.text : `Sir, a reminder: ${due.text}.`;
    pushLog("agent", line);
    if (mutedRef.current) return;
    const turn = ++turnRef.current;
    clearFollowUpTimer();
    setStatusNow("speaking");
    player().enqueue(line);
    void player()
      .whenIdle()
      .then(() => {
        if (turn !== turnRef.current) return;
        if (reminderQueueRef.current.length) {
          setStatusNow("wake");
          announceReminders();
        } else {
          armFollowUpWindow();
        }
      });
  }, [handleUtterance, pushLog, clearFollowUpTimer, setStatusNow, armFollowUpWindow]);

  /** Push-to-talk: stop whatever ULTRON is doing and listen for a command
   *  right away, no wake word needed. */
  const listenNow = useCallback(() => {
    if (statusRef.current === "confirm" || statusRef.current === "unsupported") return;
    interrupt();
    playChime();
    armFollowUpWindow();
  }, [interrupt, armFollowUpWindow]);

  // The global hotkey (and anything else the server wants the page to do).
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("listen", () => listenNow());
    return () => events.close();
  }, [listenNow]);

  // Opened by the hotkey when no page was open: listen once the mic is up.
  useEffect(() => {
    if (!stt || !new URLSearchParams(window.location.search).has("listen")) return;
    window.history.replaceState(null, "", window.location.pathname);
    const t = setTimeout(listenNow, 800);
    return () => clearTimeout(t);
  }, [stt, listenNow]);

  // Webcam presence (Settings): greet the user when they come back, and
  // lock the PC when they've been away long enough. Only on the PC itself —
  // a phone watching its owner leave must not lock the computer.
  useEffect(() => {
    if (!stt?.presence?.enabled || !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) return;
    const lockMinutes = stt.presence.lockMinutes;
    const watcher = new PresenceWatcher({
      onArrive: (awayMs) => {
        const hour = new Date().getHours();
        const greeting = awayMs > 4 * 60 * 60_000 ? (hour < 12 ? "Good morning, sir." : hour < 17 ? "Good afternoon, sir." : "Good evening, sir.") : "Welcome back, sir.";
        reminderQueueRef.current.unshift({ id: `presence-${Date.now()}`, kind: "notice", text: greeting });
        announceReminders();
      },
      onAway: (awayMs) => {
        if (lockMinutes > 0 && awayMs >= lockMinutes * 60_000) {
          void fetch("/api/presence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "away", awayMinutes: Math.floor(awayMs / 60_000) }),
          }).catch(() => {});
        }
      },
    });
    watcher.start().catch((err) => pushLog("error", `Webcam presence couldn't start: ${err instanceof Error ? err.message : String(err)}`));
    return () => watcher.stop();
  }, [stt, announceReminders, pushLog]);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/reminders?due=1", { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as { due?: DueReminder[] };
          if (!stopped && data.due?.length) {
            reminderQueueRef.current.push(...data.due);
            announceReminders();
          }
        }
      } catch {
        // server restarting — try again next tick
      }
    };
    void poll();
    const id = setInterval(() => {
      void poll();
      announceReminders(); // also retries anything queued while busy
    }, REMINDER_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [announceReminders]);

  useEffect(() => {
    if (!stt) return;
    const Ctor = stt.engine === "whisper" ? (WhisperRecognizer as unknown as new () => SpeechRecognition) : window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      setStatusNow("unsupported");
      return;
    }
    const recognition = new Ctor();
    if (stt.engine === "whisper") {
      const wr = recognition as unknown as WhisperRecognizer;
      // While waiting for "Hey ULTRON" the server checks with a small fast
      // model first — the offline wake word.
      wr.getMode = () => (wakeModeRef.current && statusRef.current === "wake" ? "wake" : "command");
      let lastRejectLog = 0;
      wr.onrejected = () => {
        if (Date.now() - lastRejectLog < 60_000) return;
        lastRejectLog = Date.now();
        pushLog("action", "Ignored a voice that isn't yours (voice lock).");
      };
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    // Chrome needs a locale; Whisper takes the language from Settings itself.
    recognition.lang =
      stt.language === "hi" ? "hi-IN" : navigator.language.toLowerCase().startsWith("en") ? navigator.language : "en-US";

    // Chrome's recognizer runs on Google's servers; when they can't be
    // reached it fails with "network" over and over. Say so once, retry
    // with growing pauses, and switch to local Whisper if it's installed.
    let networkFailures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    recognition.onresult = (event) => {
      networkFailures = 0;
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      const s = statusRef.current;
      const busy = s === "thinking" || s === "speaking";
      if (utteranceStartRef.current === null) utteranceStartRef.current = performance.now();
      if (!finalText) {
        // While ULTRON talks the mic mostly hears ULTRON — don't show it.
        if (!busy) setInterim(interimText);
        return;
      }
      setInterim("");
      // Speaking pace from the first partial result to the final one.
      const seconds = (performance.now() - (utteranceStartRef.current ?? performance.now())) / 1000;
      utteranceStartRef.current = null;
      const wordCount = finalText.trim().split(/\s+/).length;
      const measured = seconds > 0.8 && wordCount >= 4 ? { wordsPerSecond: wordCount / seconds } : {};
      if (s === "confirm") return;

      // Barge-in: while ULTRON is thinking or talking, the mic stays on but
      // only two things count — a stop phrase, or the wake word followed
      // by a new command. Everything else is most likely its own voice.
      if (busy) {
        if (isStopCommand(finalText)) {
          interrupt();
          interruptedRef.current = true;
          pushLog("user", finalText.trim());
          goIdle();
          return;
        }
        const command = leadingWakeCommand(finalText);
        if (command === null) return;
        interrupt();
        interruptedRef.current = true;
        if (command) handleUtterance(command, measured);
        else armFollowUpWindow();
        return;
      }

      const p = player();
      if (Date.now() - p.lastActiveAt < ECHO_GUARD_MS && looksLikeEcho(finalText, p.lastSpoken)) return;

      if (wakeModeRef.current) {
        const remainder = detectWake(finalText);
        if (remainder === null) return; // no wake word — stay passively listening
        if (remainder) {
          handleUtterance(remainder, measured);
        } else {
          wakeModeRef.current = false;
          setStatusNow("listening");
        }
      } else {
        // In the follow-up window the wake word is optional, but people
        // still say it — strip it so the model doesn't get "hey ultron ...".
        const command = stripLeadingWake(finalText);
        if (!command) return; // just "hey ultron" again — keep listening
        if (isStopCommand(finalText)) {
          goIdle(); // "never mind" ends the follow-up window
          return;
        }
        clearFollowUpTimer();
        wakeModeRef.current = true;
        handleUtterance(command, measured);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        if (!unsupportedRef.current) {
          pushLog("error", "Microphone access denied — allow it from the address bar, then reload.");
        }
        unsupportedRef.current = true;
        setStatusNow("unsupported");
        return;
      }
      if (event.error === "network") {
        networkFailures++;
        if (stt.engine === "browser" && stt.whisperInstalled) {
          pushLog("action", "Chrome's speech service can't be reached — switching to local Whisper.");
          setStt({ ...stt, engine: "whisper" });
          return;
        }
        if (networkFailures === 1) {
          pushLog(
            "error",
            "Can't reach Chrome's speech service (it needs internet access to Google). Check your connection, VPN or firewall, and use Chrome itself rather than Brave/Opera — or install local Whisper (scripts\\install-whisper.ps1) to hear offline. Retrying quietly…",
          );
        }
        return;
      }
      pushLog("error", `Mic error: ${event.error}`);
    };

    // The recognizer stops itself after silence; keep it running (it stays
    // on while ULTRON speaks, so "stop" works) except during a confirm.
    recognition.onend = () => {
      setInterim("");
      if (mutedRef.current || unsupportedRef.current || statusRef.current === "confirm") return;
      const restart = () => {
        retryTimer = null;
        if (mutedRef.current || unsupportedRef.current || statusRef.current === "confirm") return;
        try {
          recognition.start();
        } catch {
          // ignore
        }
      };
      if (networkFailures > 0) {
        retryTimer = setTimeout(restart, Math.min(30_000, 1000 * 2 ** Math.min(networkFailures, 5)));
      } else {
        restart();
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // ignore
    }

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      recognition.onend = null;
      recognition.abort();
    };
  }, [stt, handleUtterance, pushLog, clearFollowUpTimer, interrupt, goIdle, armFollowUpWindow, setStatusNow]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  const toggleMute = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
      goIdle();
    } else {
      mutedRef.current = true;
      setMuted(true);
      clearFollowUpTimer();
      player().stop();
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }
  }, [goIdle, clearFollowUpTimer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "v" || e.key === "V") {
        if (document.activeElement?.tagName === "INPUT") return;
        toggleMute();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMute]);

  const resolvePending = useCallback(
    (approved: boolean) => {
      if (!pending) return;
      const token = pending.token;
      setPending(null);
      void callAgent({ token, approved });
    },
    [pending, callAgent],
  );

  const statusLabel: Record<AgentStatus, string> = {
    wake: "SAY “HEY ULTRON”",
    listening: "LISTENING…",
    thinking: "THINKING…",
    speaking: "SPEAKING…",
    confirm: "CONFIRM REQUIRED",
    unsupported: "MIC UNSUPPORTED",
  };

  return (
    <div className="hud agent-panel">
      <a href="/settings" className="agent-settings-link" title="Settings, memory, costs">
        ⚙ SETTINGS
      </a>
      <div className={`agent-status agent-status-${status}`}>{muted ? "MUTED" : statusLabel[status]}</div>

      {interim && <div className="agent-interim">“{interim}”</div>}

      <div className="agent-log">
        {log.map((entry) => (
          <div key={entry.id} className={`agent-entry agent-entry-${entry.kind}`}>
            <span className="agent-entry-prefix">
              {entry.kind === "user" ? "YOU" : entry.kind === "action" ? "ACT" : entry.kind === "error" ? "ERR" : "ULTRON"}
            </span>
            {entry.text}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {pending && (
        <div className="confirm-modal">
          <div className="confirm-title">CONFIRM ACTION</div>
          {pending.toolUse.map((t) => (
            <div key={t.id} className="confirm-item">
              <div>
                {t.name.replace(/_/g, " ")}
                {typeof t.input.path === "string" ? ` → ${t.input.path}` : ""}
                {typeof t.input.id === "string" ? ` → ${t.input.id}` : ""}
              </div>
              {/* run_code executes with the user's full permissions — never
                  ask them to approve code they can't see. */}
              {typeof t.input.code === "string" && (
                <pre className="confirm-detail confirm-code">
                  {typeof t.input.language === "string" ? `${t.input.language}:\n` : ""}
                  {t.input.code}
                </pre>
              )}
              {typeof t.input.task === "string" && <div className="confirm-detail">{t.input.task}</div>}
              {typeof t.input.name === "string" && Array.isArray(t.input.confirmed_steps) && (
                <div className="confirm-detail">
                  &quot;{t.input.name}&quot; will:
                  {(t.input.confirmed_steps as { tool: string; input: Record<string, unknown> }[]).map((s, i) => (
                    <div key={i}>
                      {i + 1}. {s.tool.replace(/_/g, " ")} {JSON.stringify(s.input)}
                    </div>
                  ))}
                </div>
              )}
              {typeof t.input.message === "string" && (
                <div className="confirm-detail">
                  To: {String(t.input.to ?? "")}
                  <div>{t.input.message}</div>
                </div>
              )}
              {typeof t.input.to === "string" && typeof t.input.message !== "string" && (
                <div className="confirm-detail">
                  To: {t.input.to}
                  {typeof t.input.subject === "string" && <div>Subject: {t.input.subject}</div>}
                  {typeof t.input.body === "string" && <div>{t.input.body}</div>}
                </div>
              )}
            </div>
          ))}
          <div className="confirm-row">
            <button type="button" className="hud-btn" onClick={() => resolvePending(true)}>
              CONFIRM
            </button>
            <button type="button" className="hud-btn" onClick={() => resolvePending(false)}>
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
