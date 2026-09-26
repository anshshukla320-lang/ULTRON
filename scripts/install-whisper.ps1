# Installs whisper.cpp (local, offline speech recognition) for ULTRON into
# ~/.ultron/whisper. Then choose "Whisper (local)" under Settings > Hearing.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-whisper.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-whisper.ps1 -Model base
#
# Models: tiny (75 MB, fastest), base (142 MB), small (466 MB, recommended —
# much better at Hindi and Hinglish), medium (1.5 GB, most accurate, slow).

param([ValidateSet("tiny", "base", "small", "medium")][string]$Model = "small")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # makes Invoke-WebRequest far faster

$dir = Join-Path $HOME ".ultron\whisper"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$exe = Get-ChildItem -Path $dir -Recurse -Include "whisper-cli.exe", "main.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
  Write-Host "Finding the newest whisper.cpp release with a Windows build..."
  # The very latest release sometimes has no binaries attached (yet), so
  # walk back through recent releases to the newest one that does. Asset
  # names also change, so the plain 64-bit Windows CPU build is picked by
  # pattern, skipping GPU builds.
  $gpu = "cublas|cuda|vulkan|blas|clblast|opencl|sycl|arm64|win32|x86\b"
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15" -Headers @{ "User-Agent" = "ULTRON" }
  $asset = $null
  $release = $null
  foreach ($r in $releases) {
    if ($r.draft -or $r.prerelease) { continue }
    $zips = $r.assets | Where-Object { $_.name -like "*.zip" -and $_.name -notmatch $gpu }
    $asset = ($zips | Where-Object { $_.name -eq "whisper-bin-x64.zip" }) | Select-Object -First 1
    if (-not $asset) { $asset = $zips | Where-Object { $_.name -match "^whisper.*(bin|win).*x64.*\.zip$" } | Select-Object -First 1 }
    if (-not $asset) { $asset = $zips | Where-Object { $_.name -match "win" -and $_.name -match "x64" } | Select-Object -First 1 }
    if ($asset) { $release = $r; break }
  }
  if (-not $asset) { throw "None of the last $($releases.Count) whisper.cpp releases has a Windows x64 build attached." }
  Write-Host "whisper.cpp $($release.tag_name)"
  Write-Host "Using $($asset.name)"
  $zip = Join-Path $env:TEMP $asset.name
  Write-Host "Downloading whisper.cpp $($release.tag_name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  Remove-Item $zip
  $exe = Get-ChildItem -Path $dir -Recurse -Include "whisper-cli.exe", "main.exe" | Select-Object -First 1
  if (-not $exe) { throw "whisper.cpp downloaded, but no whisper-cli.exe was inside." }
}

$modelFile = Join-Path $dir "ggml-$Model.bin"
if (-not (Test-Path $modelFile)) {
  Write-Host "Downloading the $Model speech model..."
  Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin" -OutFile $modelFile -UseBasicParsing
}

Write-Host "Whisper is ready ($($exe.Name), $Model model). In ULTRON: Settings > Hearing > Whisper (local)."
