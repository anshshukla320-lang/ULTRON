# Runs ULTRON in the background with a system-tray icon: the server starts
# hidden, and reminders, timers, notices and the daily briefing are announced
# (Windows notification + spoken) even with no browser tab open.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ultron-background.ps1
#
# To start it automatically with Windows: scripts\install-startup.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$url = "http://localhost:3000"

# Build once, and again whenever the code has changed (e.g. after git pull).
$head = (git rev-parse HEAD 2>$null)
$stamp = Join-Path $root ".next\ultron-built-from"
$built = if (Test-Path $stamp) { Get-Content $stamp -Raw } else { "" }
if (-not (Test-Path (Join-Path $root ".next\BUILD_ID")) -or ($head -and $built.Trim() -ne $head)) {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
  if ($head) { Set-Content -Path $stamp -Value $head }
}

$server = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "start" -WorkingDirectory $root -WindowStyle Hidden -PassThru

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Text = "ULTRON"
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("Open ULTRON").add_Click({ Start-Process $url })
$menu.Items.Add("Settings").add_Click({ Start-Process "$url/settings" })
$menu.Items.Add("-") | Out-Null
$menu.Items.Add("Quit ULTRON").add_Click({
  # /T takes the whole tree (npm -> node) with it.
  taskkill /PID $server.Id /T /F | Out-Null
  $icon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $url })
$icon.ShowBalloonTip(4000, "ULTRON", "Running in the background. Right-click the tray icon for options.", [System.Windows.Forms.ToolTipIcon]::Info)

# If the server dies, don't leave a dead tray icon behind.
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 5000
$watch.add_Tick({
  if ($server.HasExited) {
    $icon.ShowBalloonTip(4000, "ULTRON", "The ULTRON server stopped.", [System.Windows.Forms.ToolTipIcon]::Warning)
    Start-Sleep -Seconds 4
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$watch.Start()

[System.Windows.Forms.Application]::Run()
