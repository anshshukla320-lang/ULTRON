// Pure audio helpers for the local-Whisper recognizer (no browser APIs, so
// they can be unit-tested).

/** Linear-interpolating resampler to 16 kHz mono (what Whisper expects). */
export function downsample(input: Float32Array, fromRate: number, toRate = 16000): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0);
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
}

export type VadEvent = { type: "start" } | { type: "end"; audio: Float32Array } | null;

/**
 * Energy-based voice activity detector. Feed it fixed-size frames; it says
 * when speech starts, and hands back the whole utterance (with a little
 * audio from just before it started) when speech ends.
 */
export class Vad {
  private noise = 0.005;
  private loudFrames = 0;
  private quietMs = 0;
  private speaking = false;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private utteranceMs = 0;

  constructor(
    private readonly frameMs: number,
    private readonly opts = { startFrames: 3, endSilenceMs: 700, maxMs: 15_000, prerollMs: 300, minThreshold: 0.012 },
  ) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  push(frame: Float32Array): VadEvent {
    const level = rms(frame);
    const threshold = Math.max(this.opts.minThreshold, this.noise * 3);
    const loud = level > threshold;
    if (!this.speaking) {
      // Track background noise only while nobody is talking.
      if (!loud) this.noise = this.noise * 0.95 + level * 0.05;
      this.preroll.push(frame);
      while (this.preroll.length * this.frameMs > this.opts.prerollMs) this.preroll.shift();
      this.loudFrames = loud ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= this.opts.startFrames) {
        this.speaking = true;
        this.utterance = [...this.preroll];
        this.utteranceMs = this.utterance.length * this.frameMs;
        this.quietMs = 0;
        return { type: "start" };
      }
      return null;
    }
    this.utterance.push(frame);
    this.utteranceMs += this.frameMs;
    this.quietMs = loud ? 0 : this.quietMs + this.frameMs;
    if (this.quietMs >= this.opts.endSilenceMs || this.utteranceMs >= this.opts.maxMs) {
      const total = this.utterance.reduce((n, f) => n + f.length, 0);
      const audio = new Float32Array(total);
      let off = 0;
      for (const f of this.utterance) {
        audio.set(f, off);
        off += f.length;
      }
      this.speaking = false;
      this.loudFrames = 0;
      this.utterance = [];
      this.preroll = [];
      return { type: "end", audio };
    }
    return null;
  }
}
