# Installs an extra Piper voice so Ultron can speak a foreign language with a
# native accent during language practice. Voices go next to the default
# English one in ~/.ultron/piper/piper/ and are picked up automatically by
# language code — no restart or config needed.
#
# Also installs other English voices for ULTRON itself (jarvis, butler,
# us-male, us-female, uk-female, narrator) — choose them under Settings > Voice.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-piper-voice.ps1 es
#         powershell -ExecutionPolicy Bypass -File scripts\install-piper-voice.ps1 butler
#         powershell -ExecutionPolicy Bypass -File scripts\install-piper-voice.ps1 fr_FR-siwis-medium
#
# Pass a language code to get the recommended voice below, or any full voice
# name listed at https://rhasspy.github.io/piper-samples/ (you can listen to
# each one there first). Piper has no Japanese or Korean voices — those fall
# back to ElevenLabs or Windows' own voice for that language.

param([Parameter(Mandatory = $true)][string]$Voice)

$ErrorActionPreference = "Stop"

$Recommended = @{
  "es"    = "es_ES-davefx-medium"
  "es-MX" = "es_MX-claude-high"
  "fr"    = "fr_FR-siwis-medium"
  "de"    = "de_DE-thorsten-medium"
  "it"    = "it_IT-paola-medium"
  "pt"    = "pt_BR-faber-medium"
  "pt-BR" = "pt_BR-faber-medium"
  "ru"    = "ru_RU-irina-medium"
  "zh"    = "zh_CN-huayan-medium"
  "nl"    = "nl_NL-mls-medium"
  "hi"    = "hi_IN-pratham-medium"
  "ar"    = "ar_JO-kareem-medium"
  "tr"    = "tr_TR-dfki-medium"
  "pl"    = "pl_PL-gosia-medium"
  # Other voices for ULTRON itself — pick one under Settings > Voice.
  "jarvis"    = "en_GB-alan-medium"
  "butler"    = "en_GB-northern_english_male-medium"
  "us-male"   = "en_US-ryan-high"
  "us-female" = "en_US-lessac-high"
  "uk-female" = "en_GB-cori-high"
  "narrator"  = "en_US-joe-medium"
}
if ($Recommended.ContainsKey($Voice)) { $Voice = $Recommended[$Voice] }

# Voice names look like <lang>_<REGION>-<speaker>-<quality>.
if ($Voice -notmatch '^(?<lang>[a-z]{2,3})_(?<region>[A-Z]{2})-(?<speaker>[A-Za-z0-9_]+)-(?<quality>x_low|low|medium|high)$') {
  throw "Unrecognised voice '$Voice'. Use a language code ($($Recommended.Keys -join ', ')) or a full name like fr_FR-siwis-medium."
}

$PiperDir = Join-Path $HOME ".ultron\piper\piper"
if (-not (Test-Path (Join-Path $PiperDir "piper.exe"))) {
  throw "Piper isn't installed at $PiperDir yet — install Piper (with the default English voice) first."
}

$Base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/$($Matches.lang)/$($Matches.lang)_$($Matches.region)/$($Matches.speaker)/$($Matches.quality)/$Voice"
foreach ($ext in ".onnx", ".onnx.json") {
  $dest = Join-Path $PiperDir "$Voice$ext"
  Write-Host "Downloading $Voice$ext ..."
  Invoke-WebRequest -Uri "$Base$ext" -OutFile $dest -UseBasicParsing
}
if ($Voice -like "en_*") {
  Write-Host "Installed $Voice. Choose it under Settings > Voice in ULTRON."
} else {
  Write-Host "Installed $Voice. Ultron will now use it for that language."
}
