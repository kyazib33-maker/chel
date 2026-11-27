# Etapa 3 — Servidor remoto, pareamento e Usage

## Entregas

### Host remoto

- `crates/remote-server`: API REST + WebSocket com Axum 0.8.
- Porta padrão `17891`.
- Inicia somente após ação explícita na interface Desktop.
- Modo padrão do backend: `127.0.0.1` (loopback).
- Modo LAN: bind explícito em `0.0.0.0`, com anúncio do IPv4 local e, quando disponível, do IPv4 retornado por `tailscale ip -4`.
- Endpoint de saúde: `GET /health`.

### Pareamento

1. O Desktop solicita um desafio aleatório de uso único, válido por 180 segundos.
2. O QR contém versão do protocolo, endpoints, desafio e expiração. Não contém o token permanente do dispositivo.
3. O Mobile envia `POST /api/v1/pair` com o desafio e um nome de dispositivo.
4. O Host gera um token aleatório, armazena somente seu SHA-256 no SQLite e retorna o token uma vez.
5. O Mobile armazena o token com `expo-secure-store`.
6. O Desktop permite listar e revogar dispositivos pareados.

### REST autenticado

- `GET /api/v1/tasks`
- `GET /api/v1/tasks/{id}`
- `POST /api/v1/tasks` — inicia um agente autenticado; o `cwd` precisa estar dentro do diretório pessoal configurado no Host.
- `DELETE /api/v1/tasks/{id}` — solicita cancelamento.
- `GET /api/v1/usage`
- `GET /api/v1/devices`

As rotas autenticadas exigem `Authorization: Bearer <device_token>`.

### WebSocket

- Endpoint: `GET /ws`.
- O primeiro frame deve ser `{"type":"authenticate","token":"...","last_sequence":null}`.
- Após autenticação, o Host envia `authenticated` e um `snapshot` inicial ou `replay` desde a última sequência global informada.
- Eventos de tarefa são armazenados em um journal circular de 4.096 entradas e publicados em tempo real.
- Se o cliente ficar atrás da capacidade do broadcast, recebe `resync_required` e deve reconectar solicitando snapshot/replay.
- Métricas de Usage são atualizadas por mensagens `usage` a cada 10 segundos.

### Usage

O contrato mantém separados `historical` e `live`, para evitar somar duas vezes uma execução que já foi persistida pelo CLI.

- Claude Code: leitura dos históricos JSONL em `~/.claude/projects`, somando mensagens do tipo assistant e mantendo a última revisão por `message.id`. Registros de subagents/tool-results são ignorados. Respeita `CLAUDE_CONFIG_DIR` quando absoluto.
- Codex: leitura dos JSONL em `~/.codex/sessions`, utilizando o último `event_msg`/`token_count` por arquivo. Respeita `CODEX_HOME` quando absoluto.
- Antigravity: leitura histórica ainda não habilitada porque o layout de persistência local não foi confirmado. O adapter observa eventos JSON com usage durante execução quando o CLI os fornece.
- Rate limit e cota excedida são reconhecidos por padrões textuais em stdout/stderr. O indicador apresentado é a última detecção durante a execução atual do Host, não uma leitura oficial nem uma garantia de que o limite continua ativo.
- Tempo de execução é calculado a partir dos snapshots mantidos pelo Process Manager.
- Cotas oficiais de assinatura permanecem indisponíveis por este mecanismo e não são inventadas.

## Segurança e limites

- LAN vem desligada por padrão no painel; é necessário habilitá-la explicitamente para conectar o Mobile.
- O serviço não configura port forwarding nem abre portas no roteador. No Windows, autorize a entrada TCP na porta `17891` somente para redes privadas quando o Firewall solicitar; não crie regra para redes públicas.
- O modo LAN utiliza HTTP simples. Ele deve ser usado somente em rede confiável; em redes não confiáveis, prefira o endpoint Tailscale, cujo tráfego passa pelo túnel autenticado/criptografado do Tailscale. Não exponha a porta diretamente à Internet.
- O Mobile configura explicitamente o tráfego HTTP para o fluxo de rede local (Android `usesCleartextTraffic` e iOS `NSAllowsLocalNetworking`). No Android, `usesCleartextTraffic` é uma política ampla da aplicação, embora o cliente aceite apenas IPs privados/Tailscale vindos do QR; no iOS, `NSAllowsLocalNetworking` é a exceção voltada a recursos locais e não desativa globalmente ATS. Isso permite o pareamento LAN com o Host HTTP, mas não cifra o tráfego; o token continua sujeito a captura por alguém com acesso à mesma rede.
- O QR contém um código temporário, nunca um token permanente.
- Tokens permanentes têm alta entropia e são armazenados como hash SHA-256 no SQLite local.
- O caminho de trabalho remoto é canonicalizado e limitado ao diretório pessoal configurado no Host.
- Dispositivos revogados deixam de autenticar imediatamente.
- A autenticação do WebSocket é feita no primeiro frame, evitando token em URL/query string e logs de requisição.
- O Host continua hospedado dentro do processo Tauri nesta versão; daemon independente e sobrevivência a encerramento do Desktop continuam fora do escopo desta etapa.

## Validação

Testes Rust adicionados:

- SHA-256 dos tokens de dispositivo.
- Guard de caminho contra prefixos de diretório enganosos.
- Replay de eventos a partir de uma sequência global.
- Revogação de token persistido no SQLite.
- Handshake WebSocket com token e snapshot inicial usando `tokio-tungstenite` como cliente de teste.
- Parse e deduplicação de usage Claude/Codex.
- Detecção de rate limit em stderr.

Comandos para Windows 11:

```powershell
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm install
pnpm --filter @orchestrator/shared-types typecheck
pnpm --filter @orchestrator/desktop typecheck
pnpm --filter @orchestrator/desktop build
pnpm --filter @orchestrator/mobile typecheck
```

O ambiente de geração desta etapa não possui Rust/Cargo nem dependências PNPM instaladas. Os testes foram adicionados, mas ainda precisam ser executados no Windows de destino.
