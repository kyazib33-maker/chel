[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$failures = [System.Collections.Generic.List[string]]::new()

Write-Host "Chel · revisão de segurança local" -ForegroundColor Cyan
$secretPatterns = @(
  @{ Name = "OpenAI-style key"; Regex = 'sk-[A-Za-z0-9_-]{24,}' },
  @{ Name = "Anthropic-style key"; Regex = 'sk-ant-[A-Za-z0-9_-]{20,}' },
  @{ Name = "GitHub token"; Regex = '(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})' },
  @{ Name = "AWS access key"; Regex = 'AKIA[0-9A-Z]{16}' },
  @{ Name = "Bot token"; Regex = 'xox[baprs]-[A-Za-z0-9-]{20,}' }
)
$excluded = @("node_modules", "target", ".git", "dist", ".expo", "bundle")
$files = Get-ChildItem -Path $root -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
  $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/')
  $parts = $relative -split '[\\/]+'
  $excludedMatch = $parts | Where-Object { $excluded -contains $_ } | Select-Object -First 1
  ($null -eq $excludedMatch) -and
  $_.Extension -notin @(".png", ".ico", ".jpg", ".jpeg", ".webp", ".zip", ".pdf") -and $_.Length -lt 5MB
}
foreach ($file in $files) {
  $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
  if ($null -eq $text) { continue }
  foreach ($pattern in $secretPatterns) {
    if ($text -match $pattern.Regex) { $failures.Add("$($pattern.Name): $($file.FullName)") }
  }
}

$envFiles = Get-ChildItem -Path $root -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ".env*" -and $_.Name -ne ".env.example" }
foreach ($file in $envFiles) { $failures.Add("Arquivo de ambiente local precisa permanecer fora do pacote: $($file.FullName)") }

$adapter = Get-Content -LiteralPath (Join-Path $root "crates/antigravity-adapter/src/lib.rs") -Raw
if ($adapter -match '--dangerously-skip-permissions') { $failures.Add("Flag de bypass de permissões detectada no adapter Antigravity.") }

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Host "[FALHA] $_" -ForegroundColor Red }
  throw "Revisão de segurança reprovada ($($failures.Count) item(ns))."
}
Write-Host "[OK] Nenhum padrão conhecido de credencial foi encontrado nos arquivos verificados." -ForegroundColor Green
Write-Host "Observação: este scanner é heurístico e não substitui secret scanning profissional nem revisão manual." -ForegroundColor Yellow
