$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$failed = $false
function Check([string]$Label, [scriptblock]$Action) {
  Write-Host "== $Label ==" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { $script:failed = $true; Write-Host "[FALHA] $Label" -ForegroundColor Red } else { Write-Host "[OK] $Label" -ForegroundColor Green }
}
Check "Format Rust" { cargo fmt --all -- --check }
Check "Tests Rust" { cargo test --workspace }
Check "Clippy Rust" { cargo clippy --workspace --all-targets -- -D warnings }
Check "Typecheck Desktop" { pnpm --filter @orchestrator/desktop typecheck }
Check "Build Desktop" { pnpm --filter @orchestrator/desktop build }
Check "Security scan" { powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/security-audit.ps1 }
if ($failed) { throw "Release gate não passou. Corrija as falhas antes de publicar." }
Write-Host "Todos os gates passaram. Este script não certifica testes reais com os CLIs do usuário." -ForegroundColor Green
