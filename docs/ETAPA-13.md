# Etapa 13 — Controle remoto de sessões

## Entregas

- O RemoteServer recebe instâncias compartilhadas dos managers Claude Code e Codex App Server, além do manager Antigravity já existente.
- `POST /api/v1/sessions/{id}/resume` passa a retomar Claude Code por `--resume`, Codex por `thread/resume` e Antigravity pelo conversation ID/cache.
- Claude Code e Codex aceitam mensagens adicionais em `POST /api/v1/sessions/{id}/messages` enquanto a sessão está ativa.
- Claude Code e Codex podem ser interrompidos por `POST /api/v1/sessions/{id}/stop`.
- Todas as rotas exigem autenticação de dispositivo pareado. Workspaces são canonicalizados e limitados à raiz autorizada.
- Claude retoma em `permission_mode=default`; Codex retoma em `workspace-write`. Nenhuma permissão é elevada automaticamente.
- Mobile usa as rotas para retomar sessões dos três provedores, enviar mensagens a Claude/Codex e interrompê-las.
- Catálogo de capacidades atualizado para refletir a retomada remota dos três provedores.

## Rotas

| Método | Rota | Finalidade |
|---|---|---|
| POST | `/api/v1/sessions/{id}/resume` | Retomar sessão nativa; retorna `session_id` para Claude/Codex ou `task_id` para Antigravity |
| POST | `/api/v1/sessions/{id}/messages` | Enviar novo prompt para sessão Claude/Codex ativa |
| POST | `/api/v1/sessions/{id}/stop` | Encerrar processo Claude/Codex ativo |

## Limitações conhecidas

- Antigravity executa um turno headless por processo. Para enviar outro prompt, use retomada; o cancelamento pode ser feito pelo painel de tarefas associado.
- Ao retomar Claude/Codex, o manager cria um novo identificador local de sessão, preservando o identificador nativo do provedor. O endpoint retorna o novo `session_id`.
- A sincronização de eventos de processo continua usando o WebSocket/journal existente; a lista de sessões é atualizada por REST após ações e pelo refresh da tela. Um canal dedicado de eventos de sessão fica para etapa posterior.
- O envio de mensagens Claude/Codex pressupõe sessão local ainda conectada. Sessões desconectadas devem ser retomadas, não receber mensagens.

## Segurança

- Autenticação Bearer de dispositivo pareado em todas as rotas.
- Validação de UUID, prompt não vazio, status e modo de recuperação.
- Verificação de workspace contra `allowed_root` após canonicalização.
- Sem `--dangerously-skip-permissions`, `bypassPermissions` ou sandbox `danger-full-access`.

## Validação

- Verificação estática de TOML e sintaxe TypeScript/TSX executada no ambiente de desenvolvimento.
- Build e testes Rust não executados: `cargo`, `rustc` e `rustfmt` não estão disponíveis neste ambiente.
- Recomenda-se executar `cargo test --workspace` e os testes de integração com os CLIs instalados no Windows 11 antes de usar controle remoto em produção.
