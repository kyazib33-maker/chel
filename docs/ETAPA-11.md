# Etapa 11 — Antigravity Adapter e retomada nativa

## Entregas

- Novo crate `antigravity-adapter` para construir argumentos AGY sem shell.
- Execução headless com `-p` e `--output-format stream-json`.
- Retomada de conversas pelo `--conversation <id>`.
- Suporte opcional a modelo, esforço e modos documentados (`accept-edits`, `plan`, `auto`).
- Importação de conversas pelo cache oficial `~/.gemini/antigravity-cli/cache/last_conversations.json`, respeitando o vínculo workspace → conversation ID.
- Ações de retomada do Antigravity no Desktop e no Mobile.
- Endpoint remoto autenticado `POST /api/v1/sessions/{id}/resume`, com validação de raiz permitida antes de executar.
- Retomada do Codex por `thread/resume` no App Server.
- Retomada do Claude Code por `--resume` usando o ID nativo persistido.
- Correção da passagem do `SessionRegistry` para o servidor remoto, necessária para a rota de sessões.

## Limites explícitos

- Antigravity é executado em modo headless por turno. Esta etapa não implementa um canal JSON-RPC bidirecional nem intercepta permissões em tempo real do AGY.
- A política de permissões do Antigravity continua sendo controlada pelo próprio CLI e por `settings.json`. O adapter nunca injeta `--dangerously-skip-permissions`.
- A retomada do Antigravity depende de o cache local conter um conversation ID válido para o workspace. A importação é explícita no Desktop.
- O endpoint Mobile de retomada remota nesta etapa atende Antigravity. Claude e Codex permanecem retomáveis pelo Desktop até a camada remota de sessões nativas ser ampliada.
- Processos interrompidos não são restaurados automaticamente; o usuário dispara uma retomada explícita com uma nova instrução.

## Referências de protocolo

- Antigravity CLI flags e modos: https://antigravity.google/docs/cli/reference/
- Retomada e cache por workspace: https://antigravity.google/docs/cli/commands/resume
- Codex App Server `thread/resume`: https://learn.chatgpt.com/docs/app-server

## Reconciliação de estado

- Tarefas AGY iniciadas pelo executor genérico são reconciliadas após o evento de saída: o Host consulta o cache por workspace e importa a conversa automaticamente quando há um ID disponível.
- Retomadas AGY iniciadas pelo Desktop ou Mobile atualizam o status da sessão ao término do processo e sincronizam novamente o ID encontrado no cache.
- A retomada é bloqueada quando a sessão já está `starting` ou `running`, evitando duas execuções simultâneas sobre o mesmo histórico.
