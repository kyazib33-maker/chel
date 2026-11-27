# Release gate — Psylium 1.0

A versão 1.0 só está aprovada quando todos os itens abaixo passarem em uma máquina Windows 11 real:

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `pnpm --filter @orchestrator/desktop typecheck`
- [ ] `pnpm --filter @orchestrator/desktop build`
- [ ] `powershell -ExecutionPolicy Bypass -File ./scripts/security-audit.ps1`
- [ ] `powershell -ExecutionPolicy Bypass -File ./scripts/build-windows.ps1`
- [ ] Testar Claude Code com autenticação local, sessão, retomada, cancelamento e aprovação.
- [ ] Testar Codex CLI/App Server com autenticação local, thread resume, eventos e aprovações.
- [ ] Testar Antigravity CLI com autenticação local, cache de conversa, retomada e limites headless.
- [ ] Testar Mobile pareado em Wi-Fi privado e via VPN privada; revogar dispositivo e confirmar rejeição.
- [ ] Reiniciar o Host durante workflow, verificar checkpoint, alterar o repositório e confirmar que a retomada é bloqueada.
- [ ] Retomar workflow com workspace intacto; preservar nós concluídos; exigir confirmação para nós sem resultado.
- [ ] Verificar auditoria após iniciar, cancelar e retomar workflow.
- [ ] Produzir e testar MSI/NSIS em Windows 11 limpo.
- [ ] Definir assinatura de código e política de atualização antes de publicação ampla.

Este documento é um checklist, não um certificado. Itens não executados permanecem pendentes.
