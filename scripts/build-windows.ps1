[CmdletBinding()]
param(
  [switch]$SkipTests,
  [ValidateSet("nsis", "msi", "all")][string]$Bundle = "all"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "Comando obrigatório ausente: $Name" }
}

Write-Host "Psylium · Build Windows 11" -ForegroundColor Cyan
Require-Command "node"
Require-Command "pnpm"
Require-Command "rustc"
Require-Command "cargo"
Require-Command "git"

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22 ou superior é obrigatório." }
if (Get-Command rustup -ErrorAction SilentlyContinue) {
  $installedTargets = rustup target list --installed
  if ($installedTargets -notcontains "x86_64-pc-windows-msvc") { Write-Host "Target x86_64-pc-windows-msvc não listado; verifique a instalação Rust para MSVC." -ForegroundColor Yellow }
}

Write-Host "[1/6] Instalando dependências JavaScript..." -ForegroundColor Cyan
pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install falhou." }

if (-not $SkipTests) {
  Write-Host "[2/6] Formatação Rust..." -ForegroundColor Cyan
  cargo fmt --all -- --check
  if ($LASTEXITCODE -ne 0) { throw "cargo fmt falhou." }
  Write-Host "[3/6] Testes Rust..." -ForegroundColor Cyan
  cargo test --workspace
  if ($LASTEXITCODE -ne 0) { throw "cargo test falhou." }
  Write-Host "[4/6] Clippy..." -ForegroundColor Cyan
  cargo clippy --workspace --all-targets -- -D warnings
  if ($LASTEXITCODE -ne 0) { throw "cargo clippy falhou." }
} else { Write-Host "Testes Rust ignorados por opção explícita." -ForegroundColor Yellow }

Write-Host "[5/6] Typecheck e build do frontend..." -ForegroundColor Cyan
pnpm --filter @orchestrator/desktop typecheck
if ($LASTEXITCODE -ne 0) { throw "Typecheck do Desktop falhou." }
pnpm --filter @orchestrator/desktop build
if ($LASTEXITCODE -ne 0) { throw "Build Vite falhou." }

Write-Host "[6/6] Empacotamento Tauri..." -ForegroundColor Cyan
if ($Bundle -eq "all") {
  pnpm --filter @orchestrator/desktop exec tauri build
} else {
  pnpm --filter @orchestrator/desktop exec tauri build --bundles $Bundle
}
if ($LASTEXITCODE -ne 0) { throw "Empacotamento Tauri falhou." }

Write-Host "Build concluído. Artefatos em apps/desktop/src-tauri/target/release/bundle." -ForegroundColor Green
