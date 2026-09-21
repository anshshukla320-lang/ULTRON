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
const VOICE_MODEL = path.join(PIPER_DIR, "en_GB-alan-medium.onnx");

export async function isPiperAvailable(): Promise<boolean> {
  try {
    await fs.access(PIPER_EXE);
    await fs.access(VOICE_MODEL);
    return true;
  } catch {
    return false;
  }
}

export async function synthesizeWithPiper(text: string): Promise<Buffer> {
  const outFile = path.join(os.tmpdir(), `ultron-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(PIPER_EXE, ["--model", VOICE_MODEL, "--output_file", outFile]);
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
