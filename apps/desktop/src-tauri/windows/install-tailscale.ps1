# Source of the encoded command in hooks.nsh (kept for review).

$ErrorActionPreference = 'Stop'
$exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (Test-Path $exe) { Write-Output 'Tailscale ja instalado.'; exit 0 }
$msi = Join-Path $env:TEMP 'chel-tailscale-setup.msi'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi
$sig = Get-AuthenticodeSignature $msi
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Tailscale') { Remove-Item $msi -Force; Write-Output 'Assinatura do instalador do Tailscale invalida.'; exit 2 }
$p = Start-Process msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList @('/i', "`"$msi`"", '/passive', '/norestart')
Remove-Item $msi -Force -ErrorAction SilentlyContinue
exit $p.ExitCode
