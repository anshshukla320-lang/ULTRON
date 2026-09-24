import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Local, offline neural TTS (https://github.com/rhasspy/piper) — genuinely
// free forever, no API key, no per-character cost, no internet required
// once installed. Lives outside the repo/workspace since the binary + voice
// model are ~85MB and machine-specific, not something to commit or expose
// to the agent's file tools.
const PIPER_DIR = path.join(os.homedir(), ".ultron", "piper", "piper");
const PIPER_EXE = path.join(PIPER_DIR, "piper.exe");
const DEFAULT_VOICE_MODEL = path.join(PIPER_DIR, "en_GB-alan-medium.onnx");

// Extra voices for language practice are just more .onnx (+ .onnx.json)
// files dropped next to the default one — see scripts/install-piper-voice.ps1.
// Piper names them <lang>_<REGION>-<speaker>-<quality>.onnx.
const QUALITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, x_low: 3 };

/** Returns the voice model for a language code ("es", "pt-BR"), the default
 *  English voice when no code is given, or null if none is installed. */
export async function findVoiceModel(lang?: string): Promise<string | null> {
  if (!lang) {
    try {
      await fs.access(DEFAULT_VOICE_MODEL);
      return DEFAULT_VOICE_MODEL;
    } catch {
      return null;
    }
  }
  let files: string[];
  try {
    files = await fs.readdir(PIPER_DIR);
  } catch {
    return null;
  }
  const [base, region] = lang.toLowerCase().split(/[-_]/);
  const candidates = files
    .filter((f) => f.endsWith(".onnx") && f.toLowerCase().startsWith(`${base}_`))
    .map((f) => {
      const [locale, , quality] = f.slice(0, -".onnx".length).split("-");
      const regionMatch = region && locale.toLowerCase() === `${base}_${region}` ? 0 : 1;
      return { f, score: regionMatch * 10 + (QUALITY_RANK[quality] ?? 5) };
    })
    .sort((a, b) => a.score - b.score);
  return candidates.length ? path.join(PIPER_DIR, candidates[0].f) : null;
}

export async function isPiperAvailable(lang?: string): Promise<boolean> {
  try {
    await fs.access(PIPER_EXE);
  } catch {
    return false;
  }
  return (await findVoiceModel(lang)) !== null;
}

export async function synthesizeWithPiper(text: string, lang?: string): Promise<Buffer> {
  const voiceModel = await findVoiceModel(lang);
  if (!voiceModel) throw new Error(`No Piper voice installed for ${lang ?? "English"}.`);
  const outFile = path.join(os.tmpdir(), `ultron-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(PIPER_EXE, ["--model", voiceModel, "--output_file", outFile]);
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited with code ${code}: ${stderr.slice(-500)}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });

  const audio = await fs.readFile(outFile);
  fs.unlink(outFile).catch(() => {});
  return audio;
}
