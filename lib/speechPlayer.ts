import { parseSpeechSegments, type SpeechSegment } from "./speechSegments";

async function fetchSegmentAudio(segment: SpeechSegment): Promise<Blob | null> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: segment.text, lang: segment.lang }),
    });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

/**
 * Plays ULTRON's reply one chunk at a time, in order, as chunks arrive.
 * Audio for each chunk is requested the moment it's queued, so it's usually
 * ready by the time the previous chunk finishes. stop() cuts everything off
 * immediately (the "stop" voice command and muting).
 */
export class SpeechPlayer {
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private audio: HTMLAudioElement | null = null;
  /** Recent speech, for telling the mic's echo of it apart from the user. */
  lastSpoken = "";
  lastActiveAt = 0;
  /** Speaking speed from Settings (used for the browser's fallback voice). */
  rate = 1;

  enqueue(text: string): void {
    const segments = parseSpeechSegments(text);
    if (segments.length === 0) return;
    const gen = this.generation;
    this.lastSpoken = `${this.lastSpoken} ${text}`.slice(-600);
    const prefetched = segments.map((s) => ({ segment: s, audio: fetchSegmentAudio(s) }));
    this.chain = this.chain.then(async () => {
      for (const { segment, audio } of prefetched) {
        if (gen !== this.generation) return;
        const blob = await audio;
        if (gen !== this.generation) return;
        const played = blob ? await this.playBlob(blob) : false;
        if (!played && gen === this.generation) await this.speakWithBrowser(segment);
        this.lastActiveAt = Date.now();
      }
    });
  }

  /** Resolves once everything queued so far has been spoken (or stopped). */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  stop(): void {
    this.generation++;
    this.audio?.pause();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    this.chain = Promise.resolve();
    this.lastActiveAt = Date.now();
  }

  private playBlob(blob: Blob): Promise<boolean> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      const finish = (ok: boolean) => {
        if (this.audio === audio) this.audio = null;
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      // pause() (from stop) fires no "ended" event; treat it as done.
      audio.onpause = () => {
        if (!audio.ended) finish(true);
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.play().catch(() => finish(false));
    });
  }

  // Browser TTS as a last resort — robotic, but keeps the assistant from
  // going silent if Piper/ElevenLabs aren't available for this segment.
  // Setting utter.lang makes the browser pick a native voice for foreign
  // phrases when the OS has one installed.
  private speakWithBrowser(segment: SpeechSegment): Promise<void> {
    return new Promise<void>((resolve) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return resolve();
      // Chrome sometimes never fires onend/onerror (no voice installed for
      // the language, or its ~15s long-utterance bug). Without a cap ULTRON
      // would sit on "SPEAKING…" forever.
      const words = segment.text.split(/\s+/).length;
      const watchdog = setTimeout(() => {
        window.speechSynthesis.cancel();
        resolve();
      }, 3000 + words * 600);
      const done = () => {
        clearTimeout(watchdog);
        resolve();
      };
      const utter = new SpeechSynthesisUtterance(segment.text);
      if (segment.lang) {
        utter.lang = segment.lang;
      } else {
        utter.rate = 1.02 * this.rate;
        utter.pitch = 0.85;
      }
      utter.onend = done;
      utter.onerror = done;
      window.speechSynthesis.speak(utter);
    });
  }
}
