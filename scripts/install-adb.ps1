# Installs Google's ADB (Android platform-tools) for ULTRON into
# ~/.ultron/platform-tools, so it can control an Android / Google TV over
# Wi-Fi. Optionally connects to the TV straight away so you can accept the
# "Allow debugging?" prompt on the TV screen:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-adb.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-adb.ps1 -Tv 192.168.1.40

param([string]$Tv = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Join-Path $HOME ".ultron"
$adb = Join-Path $root "platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $zip = Join-Path $env:TEMP "platform-tools-windows.zip"
  Write-Host "Downloading Android platform-tools from Google..."
  Invoke-WebRequest -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $root -Force
  Remove-Item $zip -Force
}
& $adb version | Select-Object -First 1
Write-Host "ADB installed at $adb"

if ($Tv) {
  $target = if ($Tv -match ":\d+$") { $Tv } else { "${Tv}:5555" }
  Write-Host "Connecting to the TV at $target - look at the TV and accept 'Allow debugging?' (tick 'Always allow')..."
  & $adb connect $target
  Start-Sleep -Seconds 8
  $state = (& $adb -s $target get-state 2>&1) -join " "
  if ($state -match "device") {
    Write-Host "Connected. Put ANDROID_TV_HOST=$Tv in .env.local and restart ULTRON."
  } else {
    Write-Host "Not connected yet ($state). Accept the prompt on the TV, then run this again."
  }
}
