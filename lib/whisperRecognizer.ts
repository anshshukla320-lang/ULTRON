import { Vad, downsample, encodeWav } from "./audio";

// A drop-in stand-in for the browser's SpeechRecognition that records each
// utterance and has ULTRON's server transcribe it with local Whisper. It
// implements just the parts VoiceAgent uses (start/stop/abort, onresult,
// onerror, onend), so wake word, barge-in and follow-ups work unchanged.

type ResultList = { isFinal: boolean; 0: { transcript: string }; length: number }[];

export class WhisperRecognizer {
  continuous = true;
  interimResults = true;
  lang = "en";
  onresult: ((e: { resultIndex: number; results: ResultList }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  /** Set by the page: "wake" while waiting for "Hey ULTRON" (the server
   *  then checks with a small fast model first). */
  getMode: (() => "wake" | "command") | null = null;
  /** Voice lock turned an utterance away (not the owner's voice). */
  onrejected: (() => void) | null = null;

  private running = false;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private vad: Vad | null = null;
  private pending = 0;

  start(): void {
    if (this.running) throw new Error("already started"); // same as the browser's
    this.running = true;
    if (!this.stream) void this.open();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    setTimeout(() => this.onend?.(), 0);
  }

  abort(): void {
    this.stop();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.node = null;
  }

  private emit(transcript: string, isFinal: boolean): void {
    const result = Object.assign([{ transcript }], { isFinal }) as unknown as ResultList[number];
    this.onresult?.({ resultIndex: 0, results: [result] });
  }

  private async open(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      this.running = false;
      this.onerror?.({ error: "not-allowed" });
      return;
    }
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const frameSize = 2048;
    // ScriptProcessorNode is deprecated but universally supported and needs
    // no separate worklet file; the work per frame is tiny.
    this.node = this.ctx.createScriptProcessor(frameSize, 1, 1);
    this.vad = new Vad((frameSize / this.ctx.sampleRate) * 1000);
    const rate = this.ctx.sampleRate;
    this.node.onaudioprocess = (ev) => {
      if (!this.running || !this.vad) return;
      const frame = new Float32Array(ev.inputBuffer.getChannelData(0));
      const event = this.vad.push(frame);
      if (event?.type === "start") this.emit("…", false); // lets the page time the utterance
      if (event?.type === "end") void this.transcribe(downsample(event.audio, rate));
    };
    source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  private async transcribe(audio: Float32Array): Promise<void> {
    if (audio.length < 16000 * 0.35) return; // shorter than a word
    this.pending++;
    try {
      const mode = this.getMode?.() ?? "command";
      const res = await fetch(`/api/stt${mode === "wake" ? "?mode=wake" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: encodeWav(audio) as unknown as BodyInit,
      });
      const data = (await res.json()) as { text?: string; error?: string; rejected?: boolean };
      if (!res.ok) {
        this.onerror?.({ error: data.error ?? "transcription failed" });
        return;
      }
      if (data.rejected) this.onrejected?.();
      else if (data.text && this.running) this.emit(data.text, true);
    } catch {
      this.onerror?.({ error: "network" });
    } finally {
      this.pending--;
    }
  }
}
