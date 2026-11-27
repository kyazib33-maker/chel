# Etapa 30 — Segurança e preparação da versão 1.0

- `scripts/security-audit.ps1` faz busca heurística de padrões conhecidos de credenciais, arquivos `.env` locais e flag de bypass no adapter Antigravity.
- `scripts/release-check.ps1` reúne gates de formatação, testes, Clippy, typecheck, build e scanner de segurança.
- `SECURITY.md` descreve limites de rede, autenticação, armazenamento de estado, credenciais nativas e modelo de ameaças.
- `docs/RELEASE-1.0.md` contém os gates que ainda precisam passar em Windows 11 com os três CLIs instalados.

**Status:** preparação técnica para RC; não declarar versão 1.0 estável até passar os gates locais, executar workflows de ponta a ponta, verificar autenticação de cada CLI e produzir instalador assinado.
