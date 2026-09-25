import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireWindows, runPowerShell } from "./powershell";
import type { ToolOutput } from "./tools";

// Captures every monitor as one image, scaled so its longest edge is at
// most 1568px (larger images are downscaled by the API anyway and just cost
// more), saved as JPEG. SetProcessDPIAware stops Windows display scaling
// (125%, 150%) from cropping the capture.
const SCREENSHOT_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name Dpi -Namespace UltronScreen
[void][UltronScreen.Dpi]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $full.Size)
$g.Dispose()
$scale = [Math]::Min(1.0, 1568.0 / [Math]::Max($b.Width, $b.Height))
$out = New-Object System.Drawing.Bitmap $full, ([int]($b.Width * $scale)), ([int]($b.Height * $scale))
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
$out.Save($env:ULTRON_SHOT, $codec, $params)
$full.Dispose(); $out.Dispose()
Write-Output "$($b.Width)x$($b.Height)"`;

/** Takes a screenshot and hands it to Claude as an image. It's used only for
 *  the turn it was taken in; conversationHistory.stripImages drops it after. */
export async function lookAtScreen(): Promise<ToolOutput> {
  requireWindows("Looking at the screen");
  const file = path.join(os.tmpdir(), `ultron-screen-${Date.now()}.jpg`);
  try {
    const size = await runPowerShell(SCREENSHOT_SCRIPT, { ULTRON_SHOT: file });
    const data = (await fs.readFile(file)).toString("base64");
    return { text: `Screenshot of the user's screen (${size || "all monitors"}).`, image: { mediaType: "image/jpeg", data } };
  } finally {
    fs.unlink(file).catch(() => {});
  }
}
