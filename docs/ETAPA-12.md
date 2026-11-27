# Etapa 12 — Catálogo de capacidades e consolidação de runtime

## Entregas

- Novo crate `provider-runtime` com catálogo único de capacidades declaradas para Claude Code, Codex App Server e Antigravity.
- Vocabulário `NormalizedProviderEvent` para padronizar os tipos de evento que os adapters podem emitir sem apagar os payloads específicos de cada provedor.
- Endpoint remoto autenticado `GET /api/v1/providers`.
- Comando Tauri `list_provider_capabilities`.
- Página Provedores no Desktop e aba CLIs no Mobile.
- Testes unitários do catálogo e serialização de eventos.

## Matriz de capacidades

| Capacidade | Claude Code | Codex | Antigravity |
|---|---:|---:|---:|
| Execução local | Sim | Sim | Sim |
| Streaming | Sim | Sim | Sim |
| Sessões persistentes | Sim | Sim | Sim |
| Retomada nativa | Sim | Sim | Sim |
| Aprovação interativa no Host | Sim | Sim | Não |
| Retomada remota pelo Mobile | Ainda não | Ainda não | Sim |

A matriz descreve o que o Orchestrator implementa nesta versão, não o limite teórico dos produtos originais. Antigravity continua utilizando seus próprios modos de permissão.

## Contratos de eventos

`NormalizedProviderEvent` define os eventos comuns: `session_started`, `turn_started`, `text_delta`, `tool_approval_required`, `turn_completed` e `session_disconnected`. Eventos específicos dos provedores continuam disponíveis nos canais nativos para preservar dados que ainda não possuem equivalência comum.

## Segurança

- `/api/v1/providers` exige autenticação de dispositivo pareado.
- O endpoint retorna apenas metadados de capacidades; não expõe tokens, caminhos locais ou IDs de sessão.
- A UI apresenta explicitamente capacidades ainda não implementadas como indisponíveis.

## Validação

- Testes Rust adicionados ao crate `provider-runtime`.
- TOML/JSON e sintaxe TypeScript/TSX verificados estruturalmente.
- Build e testes Rust não executados neste ambiente porque `cargo`/`rustc` não estão instalados.
- Testes com CLIs reais continuam necessários no Windows 11.

## Próximas pendências

- Encaminhar todos os eventos nativos pelo mesmo barramento normalizado (mantendo payload original).
- Retomada remota para Claude e Codex, com gestão de concorrência por sessão.
- Testes de integração com executáveis simulados e CI Windows.
- Empacotamento e instalador assinado para Windows.
