import { findContactPhones } from "./contactsClient";
import { openWithShell } from "./systemActions";
import { requireWindows, runPowerShell } from "./powershell";

// Sending a WhatsApp message the legitimate way: WhatsApp has no API for
// personal accounts, so ULTRON opens the chat in the WhatsApp desktop app with
// the message typed in, then presses Enter — only once WhatsApp is actually
// the window in front, so it can never send keystrokes somewhere else.

/** Digits-only international number, or null if it doesn't look like one. */
export function normalizePhone(raw: string, defaultCountryCode = process.env.ULTRON_DEFAULT_COUNTRY_CODE ?? "91"): string | null {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  digits = digits.replace(/^0+/, ""); // trunk prefix, e.g. 098… in India
  return digits.length <= 10 ? `${defaultCountryCode}${digits}` : digits;
}

export function whatsappUrl(phone: string, message: string): string {
  return `whatsapp://send?phone=${phone}&text=${encodeURIComponent(message)}`;
}

// Waits (up to ~15s) for a window whose title contains "WhatsApp" to be in
// front, gives the chat a moment to load, then presses Enter.
const PRESS_ENTER_IN_WHATSAPP = `
$sig = @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@
$u = Add-Type -MemberDefinition $sig -Name Win -Namespace UltronWhatsApp -PassThru
for ($i = 0; $i -lt 30; $i++) {
  $sb = New-Object System.Text.StringBuilder 256
  [void]$u::GetWindowText($u::GetForegroundWindow(), $sb, 256)
  if ($sb.ToString() -like "*WhatsApp*") {
    Start-Sleep -Milliseconds 1500
    $sb2 = New-Object System.Text.StringBuilder 256
    [void]$u::GetWindowText($u::GetForegroundWindow(), $sb2, 256)
    if ($sb2.ToString() -like "*WhatsApp*") {
      $u::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
      $u::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
      Write-Output "sent"
      exit
    }
  }
  Start-Sleep -Milliseconds 500
}
Write-Output "not-focused"`;

/** send_whatsapp tool (confirmation required). */
export async function sendWhatsApp(to: string, message: string): Promise<string> {
  requireWindows("Sending WhatsApp messages");
  if (!message.trim()) throw new Error("The message is empty.");
  let phone = normalizePhone(to);
  let who = to;
  if (!phone) {
    const matches = await findContactPhones(to);
    if (matches.length === 0) throw new Error(`No contact named "${to}" with a phone number. Give me their number instead.`);
    if (matches.length > 1) {
      throw new Error(`Several contacts match "${to}": ${matches.map((m) => m.name).join(", ")}. Which one?`);
    }
    phone = normalizePhone(matches[0].phones[0]);
    who = matches[0].name;
    if (!phone) throw new Error(`${matches[0].name}'s number (${matches[0].phones[0]}) doesn't look valid.`);
  }
  try {
    await openWithShell(whatsappUrl(phone, message));
  } catch {
    // WhatsApp desktop isn't installed: WhatsApp Web, sent by hand.
    await openWithShell(`https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`);
    return `WhatsApp desktop isn't installed, so I opened WhatsApp Web with the message to ${who} ready — press Enter to send it.`;
  }
  const result = await runPowerShell(PRESS_ENTER_IN_WHATSAPP, {}, 25_000);
  return result.includes("sent")
    ? `Sent to ${who} on WhatsApp.`
    : `Opened WhatsApp with the message to ${who} ready, but it didn't come to the front — press Enter in WhatsApp to send it.`;
}
