"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type Anthropic from "@anthropic-ai/sdk";

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

interface LogEntry {
  id: number;
  kind: "user" | "agent" | "action" | "error";
  text: string;
}

let nextLogId = 1;

// How long ULTRON keeps listening for a follow-up after it finishes
// replying, before requiring the wake word again.
const FOLLOW_UP_WINDOW_MS = 8000;

// Tolerant of common mis-hearings ("hey ultron" -> "hey altron", or "hey"
// getting dropped entirely by the recognizer). Returns whatever came after
// the wake phrase in the same utterance ("" if the wake word was said
// alone), or null if no wake word was heard at all.
function detectWake(transcript: string): string | null {
  const patterns = [/\b(hey|ok)[,]?\s+(ultron|altron)\b/i, /\bultron\b/i, /\baltron\b/i];
  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (match && match.index !== undefined) {
      return transcript.slice(match.index + match[0].length).trim();
    }
  }
  return null;
}

export default function VoiceAgent() {
  const [status, setStatus] = useState<AgentStatus>("wake");
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

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

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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

  // After ULTRON replies, stay in "listening for a follow-up" mode instead
  // of immediately requiring "hey ultron" again — matches the phone call's
  // conversation loop. Reverts to wake mode on its own if nothing is said
  // within the window.
  const armFollowUpWindow = useCallback(() => {
    clearFollowUpTimer();
    wakeModeRef.current = false;
    setStatus("listening");
    resumeListening();
    followUpTimerRef.current = setTimeout(() => {
      followUpTimerRef.current = null;
      wakeModeRef.current = true;
      setStatus("wake");
    }, FOLLOW_UP_WINDOW_MS);
  }, [clearFollowUpTimer, resumeListening]);

  // Browser TTS as a last resort — robotic, but keeps the assistant from
  // going silent if ElevenLabs isn't configured or the request fails.
  const speakFallback = useCallback(
    (text: string) => {
      if (!text || typeof window === "undefined" || !window.speechSynthesis) {
        setStatus("wake");
        resumeListening();
        return;
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.02;
      utter.pitch = 0.85;
      utter.onend = () => {
        armFollowUpWindow();
      };
      setStatus("speaking");
      window.speechSynthesis.speak(utter);
    },
    [resumeListening, armFollowUpWindow],
  );

  const speak = useCallback(
    async (text: string) => {
      if (!text) return;
      setStatus("speaking");
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`TTS request failed (${res.status})`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          armFollowUpWindow();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          speakFallback(text);
        };
        await audio.play();
      } catch {
        speakFallback(text);
      }
    },
    [speakFallback, armFollowUpWindow],
  );

  const describeAction = (a: ActionLogEntry) => {
    const label = a.name.replace(/_/g, " ");
    if (a.status === "declined") return `✕ declined: ${label}`;
    if (a.status === "error") return `⚠ ${label} failed — ${a.output}`;
    return `✓ ${label}${a.output ? ` — ${a.output}` : ""}`;
  };

  const callAgent = useCallback(
    async (resolution?: { token: string; approved: boolean }) => {
      setStatus("thinking");
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: messagesRef.current, resolution }),
        });
        const data = await res.json();
        if (!res.ok) {
          pushLog("error", data.error ?? "Agent request failed.");
          setStatus("wake");
          resumeListening();
          return;
        }

        messagesRef.current = data.messages;
        for (const a of (data.actions ?? []) as ActionLogEntry[]) {
          pushLog("action", describeAction(a));
        }

        if (data.pending) {
          setPending(data.pending);
          setStatus("confirm");
          if (data.reply) pushLog("agent", data.reply);
          return;
        }

        setPending(null);
        if (data.reply) {
          pushLog("agent", data.reply);
          speak(data.reply);
        } else {
          setStatus("wake");
          resumeListening();
        }
      } catch (err) {
        pushLog("error", err instanceof Error ? err.message : String(err));
        setStatus("wake");
        resumeListening();
      }
    },
    [pushLog, speak, resumeListening],
  );

  const handleUtterance = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pushLog("user", trimmed);
      messagesRef.current = [...messagesRef.current, { role: "user", content: trimmed }];
      void callAgent();
    },
    [callAgent, pushLog],
  );

  // Stop the recognizer while ULTRON is thinking/speaking/awaiting a
  // confirmation, so it never picks up its own TTS output or captures audio
  // mid-action. Every path that leaves these states is responsible for
  // calling resumeListening() itself (see speak() and callAgent() above).
  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (status === "thinking" || status === "speaking" || status === "confirm") {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }
  }, [status]);

  useEffect(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      setStatus("unsupported");
      return;
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      if (!finalText) {
        setInterim(interimText);
        return;
      }
      setInterim("");

      if (wakeModeRef.current) {
        const remainder = detectWake(finalText);
        if (remainder === null) return; // no wake word — stay passively listening
        if (remainder) {
          handleUtterance(remainder);
        } else {
          wakeModeRef.current = false;
          setStatus("listening");
        }
      } else {
        clearFollowUpTimer();
        wakeModeRef.current = true;
        handleUtterance(finalText);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        if (!unsupportedRef.current) {
          pushLog("error", "Microphone access denied — allow it from the address bar, then reload.");
        }
        unsupportedRef.current = true;
        setStatus("unsupported");
        return;
      }
      pushLog("error", `Mic error: ${event.error}`);
    };

    recognition.onend = () => {
      setInterim("");
      if (mutedRef.current || unsupportedRef.current) return;
      if (statusRef.current === "thinking" || statusRef.current === "speaking" || statusRef.current === "confirm") {
        return;
      }
      try {
        recognition.start();
      } catch {
        // ignore
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // ignore
    }

    return () => {
      recognition.onend = null;
      recognition.abort();
    };
  }, [handleUtterance, pushLog, clearFollowUpTimer]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  const toggleMute = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
      clearFollowUpTimer();
      wakeModeRef.current = true;
      setStatus("wake");
      resumeListening();
    } else {
      mutedRef.current = true;
      setMuted(true);
      clearFollowUpTimer();
      window.speechSynthesis?.cancel();
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }
  }, [resumeListening, clearFollowUpTimer]);

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
      setStatus("thinking");
      void callAgent({ token: pending.token, approved });
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
              {typeof t.input.to === "string" && (
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
