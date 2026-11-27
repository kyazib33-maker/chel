# Etapa 29 — Build Windows 11 e distribuição

- `scripts/build-windows.ps1`: instala dependências, valida Rust/Node/Git, executa fmt/test/Clippy/typecheck/build e empacota via Tauri.
- `.github/workflows/ci.yml`: CI multiplataforma e job de bundles Windows acionado manualmente ou por tag.
- `scripts/doctor.ps1` permanece como diagnóstico somente de leitura das ferramentas e CLIs locais.

**Limites:** nenhum instalador `.msi`/`.exe` foi compilado nesta sessão. Codesigning, updater assinado, publicação e atualização automática exigem certificado e infraestrutura do operador.
