import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireWindows, runPowerShell } from "./powershell";
import type { ToolOutput } from "./tools";

// "Summarise this" / "translate what I copied" / "put that on my clipboard".

const MAX_TEXT = 60_000;

// Text first; if the clipboard holds a picture (a screenshot, a copied
// image) it's saved as JPEG so Claude can look at it.
const READ_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if ([System.Windows.Forms.Clipboard]::ContainsText()) {
  Write-Output "TEXT"
  Write-Output ([System.Windows.Forms.Clipboard]::GetText())
} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  $scale = [Math]::Min(1.0, 1568.0 / [Math]::Max($img.Width, $img.Height))
  $out = New-Object System.Drawing.Bitmap $img, ([int]($img.Width * $scale)), ([int]($img.Height * $scale))
  $out.Save($env:ULTRON_CLIP, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  Write-Output "IMAGE $($img.Width)x$($img.Height)"
} elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  Write-Output "FILES"
  [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { Write-Output $_ }
} else {
  Write-Output "EMPTY"
}`;

export function parseClipboardOutput(out: string): { kind: "text"; text: string } | { kind: "image"; size: string } | { kind: "files"; files: string[] } | { kind: "empty" } {
  const [head, ...rest] = out.replace(/\r/g, "").split("\n");
  if (head === "TEXT") return { kind: "text", text: rest.join("\n") };
  if (head?.startsWith("IMAGE")) return { kind: "image", size: head.slice(6) };
  if (head === "FILES") return { kind: "files", files: rest.filter(Boolean) };
  return { kind: "empty" };
}

/** read_clipboard tool. */
export async function readClipboard(): Promise<ToolOutput> {
  requireWindows("Reading the clipboard");
  const file = path.join(os.tmpdir(), `ultron-clip-${Date.now()}.jpg`);
  try {
    const parsed = parseClipboardOutput(await runPowerShell(READ_SCRIPT, { ULTRON_CLIP: file }));
    if (parsed.kind === "text") {
      const text = parsed.text.trim();
      if (!text) return "The clipboard is empty.";
      return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[Clipboard text truncated — it's ${text.length} characters.]` : `Clipboard text:\n${text}`;
    }
    if (parsed.kind === "image") {
      return { text: `An image copied to the clipboard (${parsed.size}).`, image: { mediaType: "image/jpeg", data: (await fs.readFile(file)).toString("base64") } };
    }
    if (parsed.kind === "files") return `Files copied to the clipboard:\n${parsed.files.join("\n")}\n(Use read_document to read one.)`;
    return "The clipboard is empty.";
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

/** write_clipboard tool. The text travels in an environment variable, never in the script. */
export async function writeClipboard(text: string): Promise<string> {
  requireWindows("Copying to the clipboard");
  if (!text) throw new Error("Nothing to copy.");
  await runPowerShell("Set-Clipboard -Value $env:ULTRON_CLIP_TEXT", { ULTRON_CLIP_TEXT: text.slice(0, MAX_TEXT) });
  return `Copied to the clipboard (${text.length} characters).`;
}
