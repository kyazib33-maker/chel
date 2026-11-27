# Etapa 7 — Codex App Server nativo

## Entrega

Foi adicionado o crate `codex-app-server`, que inicia `codex app-server --listen stdio://` sem shell e conversa por JSONL/JSON-RPC bidirecional. A integração reutiliza a autenticação local do Codex CLI; não solicita nem armazena API keys.

### Fluxo implementado

1. Inicia o App Server como subprocesso com stdin/stdout/stderr separados.
2. Negocia `initialize` e envia `initialized`.
3. Cria uma thread com `approvalPolicy: on-request` e sandbox selecionado.
4. Inicia um turno com `turn/start`.
5. Correlaciona respostas JSON-RPC por ID e transmite notificações/eventos ao Desktop.
6. Recebe solicitações iniciadas pelo servidor e responde às aprovações nativas de execução de comandos e alterações de arquivos (`item/commandExecution/requestApproval` e `item/fileChange/requestApproval`).
7. Oferece aceitar, aceitar durante a sessão, negar e cancelar.
8. Encerra o subprocesso sob demanda e limpa sessões com falha durante o handshake/inicialização.

### Interface Desktop

A página **Codex nativo** permite iniciar sessões, escolher sandbox, visualizar sessões ativas e inspecionar/decidir solicitações nativas de comando e alteração de arquivos. Eventos são enviados pelo canal Tauri `codex-event`.

### Limites deliberados

- Esta integração é específica do Codex App Server; o fluxo legado `codex exec --json` continua disponível e não foi alterado.
- Solicitações `item/permissions/requestApproval`, elicitation MCP e `tool/requestUserInput` não são aprovadas por este painel nesta etapa. Elas exigem payloads de resposta próprios e não devem receber uma resposta genérica `{ decision }`.
- O painel nativo é Desktop-only nesta etapa. A ponte para a fila unificada `PermissionEngine` e para decisões via Mobile será feita depois, preservando os IDs de request do App Server.
- Claude Code e Antigravity ainda não foram ligados a um transporte interativo nativo. O Antigravity documenta modos de execução `accept-edits`, `auto` e `plan`, mas `auto` depende de versão/plataforma/sandbox; isso não equivale a um protocolo de callbacks de aprovação do host. Claude Code tem `--input-format stream-json`, mas o contrato de controle bidirecional precisa ser validado antes de enviar respostas de aprovação.
- O App Server pode variar conforme a versão do Codex CLI instalada. O projeto não fixa nem instala uma versão automaticamente. O lançamento usa o helper multiplataforma do Host para resolver shims `.cmd` no Windows e encerrar a árvore de processos.

## Validação

- A estrutura do protocolo foi implementada com JSONL, correlação de IDs, timeout de RPC e canal de eventos.
- Testes unitários locais cobrem o formato de decisão e validação dos valores de sandbox.
- Build/testes Rust e execução contra um Codex CLI instalado não foram possíveis neste ambiente porque Rust/Cargo e o CLI não estão disponíveis. A integração deve ser validada no Windows com `codex --version` e `codex app-server --listen stdio://` antes de ser considerada produção.
