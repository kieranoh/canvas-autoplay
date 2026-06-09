$ErrorActionPreference = "Stop"

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) {
  throw "Chrome executable not found."
}

$profileDir = Join-Path $env:LOCALAPPDATA "SKKU-Lecture-Runner-Chrome"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profileDir",
  "--autoplay-policy=no-user-gesture-required",
  "https://canvas.skku.edu/"
)
