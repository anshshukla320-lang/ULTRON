import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Local speech-to-text with whisper.cpp (installed by
// scripts/install-whisper.ps1 into ~/.ultron/whisper). More accurate than the
// browser's recognizer, works offline, and understands Hindi and Hinglish.

function whisperDir(): string {
  return path.join(os.homedir(), ".ultron", "whisper");
}

const EXE_NAMES = ["whisper-cli.exe", "main.exe", "whisper-cli", "main"];
const MODEL_PREFERENCE = ["ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin", "ggml-small.en.bin", "ggml-base.en.bin", "ggml-tiny.en.bin"];

export async function findWhisper(): Promise<{ exe: string; model: string; wakeModel: string } | null> {
  const dir = whisperDir();
  let files: string[];
  try {
    files = await fs.readdir(dir, { recursive: true });
  } catch {
    return null;
  }
  const exe = EXE_NAMES.map((n) => files.find((f) => path.basename(f).toLowerCase() === n)).find(Boolean);
  const model = MODEL_PREFERENCE.map((n) => files.find((f) => path.basename(f) === n)).find(Boolean);
  if (!exe || !model) return null;
  // A small, fast model for spotting the wake word; the main one otherwise.
  const tiny = files.find((f) => path.basename(f) === "ggml-tiny.bin") ?? files.find((f) => path.basename(f) === "ggml-tiny.en.bin");
  return { exe: path.join(dir, exe), model: path.join(dir, model), wakeModel: path.join(dir, tiny ?? model) };
}

// Whisper "hears" these in near-silence or noise; a clip that transcribes to
// only one of them is treated as nothing said.
const HALLUCINATIONS = [
  /^\[?(blank_audio|music|silence|noise|inaudible|applause)\]?$/i,
  /^\(.*\)$/,
  /^(thank you|thanks|thanks for watching|you|bye|okay|\.+)[.!]?$/i,
];

export function cleanTranscript(raw: string): string {
  const text = raw
    .split("\n")
    .map((l) => l.replace(/^\[[^\]]*-->[^\]]*\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return HALLUCINATIONS.some((re) => re.test(text)) ? "" : text;
}

/** Transcribes a 16 kHz mono WAV. `language` is "en", "hi" or "auto". */
export async function transcribeWav(
  wav: Buffer,
  language: "en" | "hi" | "auto" = "en",
  opts: { wake?: boolean } = {},
): Promise<string> {
  const w = await findWhisper();
  if (!w) throw new Error("Whisper isn't installed — run scripts\\install-whisper.ps1.");
  const file = path.join(os.tmpdir(), `ultron-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await fs.writeFile(file, wav);
  try {
    // An English-only model can't do Hindi/auto; fall back to English.
    const model = opts.wake ? w.wakeModel : w.model;
    const lang = model.includes(".en.") ? "en" : language;
    // Nudging the decoder with the name makes "Ultron" come out as Ultron,
    // not "Altron" or "all Tron".
    const prompt = opts.wake ? ["--prompt", "Hey Ultron."] : [];
    const { stdout } = await execFileAsync(
      w.exe,
      ["-m", model, "-f", file, "-l", lang, "-nt", "-np", "-t", String(Math.max(2, Math.min(8, os.cpus().length))), ...prompt],
      { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return cleanTranscript(stdout);
  } finally {
    fs.unlink(file).catch(() => {});
  }
}
