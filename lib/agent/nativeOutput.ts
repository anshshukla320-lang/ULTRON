import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPowerShell } from "./powershell";
import { isPiperAvailable, synthesizeWithPiper } from "./piperTts";
import { stripSpeechMarkup } from "../speechSegments";

// How ULTRON reaches the user when no browser page is open: a Windows
// notification and/or speech through the PC's own speakers.

// PowerShell's own AppUserModelID: toasts from an unregistered app id are
// silently dropped on Windows 10/11, this one is always registered.
const TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape($env:ULTRON_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:ULTRON_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:ULTRON_APP_ID).Show($toast)`;

export async function showNotification(title: string, body: string): Promise<void> {
  if (process.platform !== "win32") {
    console.log(`[ULTRON notification] ${title}: ${body}`);
    return;
  }
  await runPowerShell(TOAST_SCRIPT, { ULTRON_TITLE: title, ULTRON_BODY: stripSpeechMarkup(body), ULTRON_APP_ID: TOAST_APP_ID });
}

// Windows' built-in voice, used when Piper isn't installed.
const SAPI_SCRIPT = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Speak($env:ULTRON_SAY)`;

const PLAY_WAV_SCRIPT = `(New-Object System.Media.SoundPlayer $env:ULTRON_WAV).PlaySync()`;

/** Says `text` through the PC's speakers and resolves when it has finished. */
export async function speakOnPc(text: string): Promise<void> {
  const plain = stripSpeechMarkup(text).trim();
  if (!plain) return;
  if (process.platform !== "win32") {
    console.log(`[ULTRON says] ${plain}`);
    return;
  }
  if (await isPiperAvailable()) {
    const wav = path.join(os.tmpdir(), `ultron-bg-${Date.now()}.wav`);
    try {
      await fs.writeFile(wav, await synthesizeWithPiper(plain));
      await runPowerShell(PLAY_WAV_SCRIPT, { ULTRON_WAV: wav }, 120_000);
      return;
    } catch {
      // fall through to the built-in voice
    } finally {
      fs.unlink(wav).catch(() => {});
    }
  }
  await runPowerShell(SAPI_SCRIPT, { ULTRON_SAY: plain }, 120_000);
}
