import { createRequire } from "node:module";
import { createWriteStream, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Voice lock: ULTRON learns what the owner's voice sounds like (a few
// sentences, recorded once in Settings) and ignores anyone else — a guest,
// the TV, a video. Runs on this PC with sherpa-onnx and a small speaker-
// recognition model; only a list of numbers describing the voice is kept.

const MODEL_NAME = "wespeaker_en_voxceleb_resnet34.onnx";
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${MODEL_NAME}`;
export const MIN_ENROLL_CLIPS = 3;

function dir(): string {
  return path.join(os.homedir(), ".ultron", "voiceid");
}
function profilePath(): string {
  return path.join(dir(), "owner.json");
}
function modelPath(): string {
  return path.join(dir(), MODEL_NAME);
}

interface Profile {
  embeddings: number[][];
  updatedAt: string;
}

/** 16-bit PCM WAV (what the page records) → samples in -1..1. */
export function wavToSamples(wav: Buffer): { sampleRate: number; samples: Float32Array } {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file.");
  let offset = 12;
  let sampleRate = 16000;
  let bits = 16;
  let channels = 1;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error("Only 16-bit WAV is supported.");
      const end = Math.min(wav.length, offset + 8 + size);
      const frames = Math.floor((end - offset - 8) / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = wav.readInt16LE(offset + 8 + i * 2 * channels) / 32768;
      return { sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no audio data.");
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Best match against the enrolled clips (the average and each clip), so one
 *  odd enrollment clip doesn't sink a genuine match. */
export function scoreAgainst(profile: number[][], e: ArrayLike<number>): number {
  if (!profile.length) return 0;
  const dim = profile[0].length;
  const mean = new Array(dim).fill(0);
  for (const p of profile) for (let i = 0; i < dim; i++) mean[i] += p[i] / profile.length;
  const perClip = profile.map((p) => cosine(p, e)).sort((a, b) => b - a);
  // Average of the mean match and the second-best clip match: robust but not
  // fooled by one clip that happens to resemble someone else.
  return (cosine(mean, e) + (perClip[1] ?? perClip[0])) / 2;
}

type Extractor = {
  createStream(): { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
  compute(stream: unknown, external?: boolean): Float32Array;
};
let extractor: Extractor | null = null;

async function ensureModel(): Promise<string> {
  const file = modelPath();
  if (existsSync(file)) return file;
  await fs.mkdir(dir(), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the voice model (${res.status}).`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  await fs.rename(tmp, file);
  return file;
}

async function getExtractor(): Promise<Extractor> {
  if (extractor) return extractor;
  const model = await ensureModel();
  let sherpa: { SpeakerEmbeddingExtractor: new (c: object) => Extractor };
  try {
    // A native addon: loaded at runtime, never bundled.
    sherpa = createRequire(path.join(process.cwd(), "package.json"))("sherpa-onnx-node");
  } catch {
    throw new Error("Voice lock needs the sherpa-onnx-node package — run npm install.");
  }
  extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 2, debug: false });
  return extractor;
}

export async function embed(wav: Buffer): Promise<number[]> {
  const { sampleRate, samples } = wavToSamples(wav);
  if (samples.length < sampleRate * 0.8) throw new Error("That clip is too short — say a full sentence.");
  const ex = await getExtractor();
  const stream = ex.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  stream.inputFinished();
  return Array.from(ex.compute(stream, false));
}

async function readProfile(): Promise<Profile | null> {
  try {
    return JSON.parse(await fs.readFile(profilePath(), "utf-8")) as Profile;
  } catch {
    return null;
  }
}

export async function voiceIdStatus(): Promise<{ enrolled: boolean; clips: number }> {
  const p = await readProfile();
  return { enrolled: (p?.embeddings.length ?? 0) >= MIN_ENROLL_CLIPS, clips: p?.embeddings.length ?? 0 };
}

/** Adds one enrollment clip. */
export async function enrollClip(wav: Buffer): Promise<{ clips: number; enrolled: boolean }> {
  const e = await embed(wav);
  const p = (await readProfile()) ?? { embeddings: [], updatedAt: "" };
  p.embeddings = [...p.embeddings, e].slice(-8);
  p.updatedAt = new Date().toISOString();
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(profilePath(), JSON.stringify(p), "utf-8");
  return { clips: p.embeddings.length, enrolled: p.embeddings.length >= MIN_ENROLL_CLIPS };
}

export async function resetVoiceId(): Promise<void> {
  await fs.rm(profilePath(), { force: true });
}

/** How much a clip sounds like the owner (0–1), or null when nobody is enrolled. */
export async function ownerScore(wav: Buffer): Promise<number | null> {
  const p = await readProfile();
  if (!p || p.embeddings.length < MIN_ENROLL_CLIPS) return null;
  return scoreAgainst(p.embeddings, await embed(wav));
}
