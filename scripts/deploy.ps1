param(
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$defaultTarget = Join-Path $repoRoot "..\..\.obsidianwin\plugins\export-note-bundle"

if ([string]::IsNullOrWhiteSpace($Target)) {
  $resolvedDefault = [System.IO.Path]::GetFullPath($defaultTarget)
  if (Test-Path $resolvedDefault) {
    $Target = $resolvedDefault
  } else {
    throw "Target plugin directory not found. Pass -Target explicitly."
  }
}

$targetPath = [System.IO.Path]::GetFullPath($Target)
New-Item -ItemType Directory -Path $targetPath -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $repoRoot "dist\main.js") -Destination (Join-Path $targetPath "main.js") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "manifest.json") -Destination (Join-Path $targetPath "manifest.json") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "versions.json") -Destination (Join-Path $targetPath "versions.json") -Force

Write-Host "Deployed runtime files to $targetPath"
