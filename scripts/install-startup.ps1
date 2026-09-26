# Makes ULTRON start in the background (tray icon) when you sign in to Windows.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 -Uninstall

param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "ULTRON.lnk"

if ($Uninstall) {
  if (Test-Path $link) { Remove-Item $link; Write-Host "ULTRON will no longer start with Windows." }
  else { Write-Host "ULTRON wasn't set to start with Windows." }
  return
}

$script = Join-Path $PSScriptRoot "ultron-background.ps1"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe")
$shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.Description = "ULTRON voice assistant (background)"
$shortcut.Save()
Write-Host "ULTRON will start in the background when you sign in. Remove it with: install-startup.ps1 -Uninstall"
