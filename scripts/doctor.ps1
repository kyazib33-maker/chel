$ErrorActionPreference = "Continue"
Write-Host "Psylium - Diagnóstico Windows" -ForegroundColor Cyan
Write-Host "Data: $(Get-Date -Format s)"
Write-Host "SO: $([System.Runtime.InteropServices.RuntimeInformation]::OSDescription)"
Write-Host "Arquitetura: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
Write-Host ""

$checks = @(
  @{ Name = "Node.js"; Command = "node"; Args = @("--version") },
  @{ Name = "npm"; Command = "npm"; Args = @("--version") },
  @{ Name = "pnpm"; Command = "pnpm"; Args = @("--version") },
  @{ Name = "Rust"; Command = "rustc"; Args = @("--version") },
  @{ Name = "Cargo"; Command = "cargo"; Args = @("--version") },
  @{ Name = "Git"; Command = "git"; Args = @("--version") },
  @{ Name = "Claude Code"; Command = "claude"; Args = @("--version") },
  @{ Name = "Codex CLI"; Command = "codex"; Args = @("--version") },
  @{ Name = "Antigravity CLI"; Command = "agy"; Args = @("--version") },
  @{ Name = "Tailscale CLI (opcional para acesso remoto)"; Command = "tailscale"; Args = @("version") }
)

foreach ($check in $checks) {
  $cmd = Get-Command $check.Command -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    Write-Host ("[AUSENTE] {0}" -f $check.Name) -ForegroundColor Yellow
  } else {
    $output = & $check.Command @($check.Args) 2>&1 | Select-Object -First 1
    Write-Host ("[OK] {0}: {1}" -f $check.Name, $output) -ForegroundColor Green
    Write-Host ("      caminho: {0}" -f $cmd.Source) -ForegroundColor DarkGray
  }
}

Write-Host ""
Write-Host "Ferramentas Windows:" -ForegroundColor Cyan
$vswhereCandidates = @("${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe", "$env:ProgramFiles\Microsoft Visual Studio\Installer\vswhere.exe")
$vswhere = $vswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($vswhere) {
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($vs) { Write-Host "[OK] MSVC C++ Build Tools: $vs" -ForegroundColor Green }
  else { Write-Host "[AUSENTE] MSVC C++ workload/Windows SDK" -ForegroundColor Yellow }
} else {
  Write-Host "[AUSENTE] Visual Studio Build Tools / vswhere" -ForegroundColor Yellow
}
if ($env:JAVA_HOME) { Write-Host "[OK] JAVA_HOME: $env:JAVA_HOME" } else { Write-Host "[INFO] JAVA_HOME não configurado (necessário para Android nativo)" -ForegroundColor DarkYellow }
if ($env:ANDROID_HOME) { Write-Host "[OK] ANDROID_HOME: $env:ANDROID_HOME" } elseif ($env:ANDROID_SDK_ROOT) { Write-Host "[OK] ANDROID_SDK_ROOT: $env:ANDROID_SDK_ROOT" } else { Write-Host "[INFO] Android SDK não detectado" -ForegroundColor DarkYellow }
$webview = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if ($webview) { Write-Host "[OK] WebView2 detectado" } else { Write-Host "[INFO] Verifique WebView2 Runtime pelo instalador oficial do Tauri" -ForegroundColor DarkYellow }
Write-Host ""
Write-Host "O script apenas consulta versões/caminhos; não lê tokens nem arquivos de autenticação." -ForegroundColor Gray
