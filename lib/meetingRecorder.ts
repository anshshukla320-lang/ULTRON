import { downsample, encodeWav } from "./audio";

// Records a meeting on this page's microphone and sends it to ULTRON in
// 30-second chunks (transcribed on the PC as they arrive). stop() sends the
// last partial chunk, marked final, so the notes include the very end.

const CHUNK_SECONDS = 30;

export class MeetingRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private buffers: Float32Array[] = [];
  private samples = 0;
  private sending: Promise<unknown> = Promise.resolve();

  constructor(private readonly id: string, private readonly onError: (msg: string) => void) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    const rate = this.ctx.sampleRate;
    this.node.onaudioprocess = (e) => {
      const frame = new Float32Array(e.inputBuffer.getChannelData(0));
      this.buffers.push(frame);
      this.samples += frame.length;
      if (this.samples >= rate * CHUNK_SECONDS) this.flush(false);
    };
    source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  private flush(final: boolean): void {
    const rate = this.ctx?.sampleRate ?? 48000;
    const all = new Float32Array(this.samples);
    let off = 0;
    for (const b of this.buffers) {
      all.set(b, off);
      off += b.length;
    }
    this.buffers = [];
    this.samples = 0;
    const wav = encodeWav(downsample(all, rate));
    // In order, one at a time — the PC appends them as they come.
    this.sending = this.sending.then(async () => {
      const res = await fetch(`/api/meeting/chunk?id=${encodeURIComponent(this.id)}${final ? "&final=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav as unknown as BodyInit,
      }).catch(() => null);
      if (res && !res.ok) this.onError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Meeting chunk failed (${res.status}).`);
    });
  }

  async stop(): Promise<void> {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.flush(true);
    await this.sending;
    await this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
