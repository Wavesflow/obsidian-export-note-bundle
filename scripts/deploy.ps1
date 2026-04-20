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

$files = @("main.js", "manifest.json", "versions.json")
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $targetPath $file) -Force
}

Write-Host "Deployed runtime files to $targetPath"
