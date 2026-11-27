# Etapa 9 — Claude Code Interactive Adapter

## Objetivo

Integrar Claude Code como sessão persistente controlada pelo Host, usando a autenticação já instalada no CLI e o protocolo bidirecional `stream-json`.

## Implementado

- Novo crate `claude-code-adapter`.
- Inicialização de processos `claude -p` com `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages` e `--permission-prompt-tool stdio`.
- Reutilização do login já existente no Claude Code; nenhuma API key é solicitada pelo Orchestrator.
- Mensagens de usuário enviadas por stdin como NDJSON.
- Captura de eventos `system/init`, `assistant`, `stream_event`, `result` e `control_request`.
- Interceptação de `can_use_tool` e encaminhamento para o Permission Engine.
- Decisões `allow`/`deny` respondidas no `control_response` correlacionado ao request original.
- A aprovação devolve o `updatedInput` original da ferramenta, sem substituir os argumentos por um objeto vazio.
- Classificação conservadora: leitura, escrita, execução, rede e comandos destrutivos.
- Expiração e desconexão limpam solicitações pendentes; fila indisponível resulta em negação, não em processo indefinidamente bloqueado.
- Sessões, mensagens subsequentes e encerramento pelo Desktop.
- Painel Desktop para iniciar, selecionar, acompanhar e conversar com sessões Claude nativas.
- Aprovações Claude aparecem na central comum do Desktop e nos endpoints remotos autenticados para Mobile; as decisões móveis são encaminhadas ao processo Claude que originou a solicitação.

## Segurança

- `bypassPermissions` não é aceito pelo adapter.
- O modo padrão é `default`; ações que chegam ao host são avaliadas pela política global.
- `ReadOnly` nega escrita e execução; `AskForSensitive` encaminha ações sensíveis para aprovação; `AllowAll` permite conforme a política escolhida.
- O host não altera configurações persistentes do usuário no Claude Code.

## Limitações conhecidas

- O protocolo `stream-json` bidirecional é parcialmente documentado; o adapter usa o contrato `can_use_tool`/`control_response` observado no protocolo do CLI/Agent SDK. A compatibilidade deve ser verificada com a versão instalada.
- A retomada por `--resume` aceita um session ID conhecido, mas a descoberta e indexação automática de todas as sessões antigas ainda não está implementada.
- O adapter captura o stream bruto para inspeção; a normalização completa de texto, uso, custos e artefatos fica para a camada de observabilidade.
- `acceptEdits`, `auto` e `dontAsk` são modos nativos do Claude Code e podem resolver permissões antes do callback do host. Para aprovação humana centralizada, use `default`.
- Não foi possível compilar Rust ou testar contra o CLI real neste ambiente: Rust/Cargo e Claude Code não estão instalados aqui.

## Verificações locais

- Validar TOML/JSON e sintaxe TypeScript/TSX.
- Conferir o ZIP e a árvore de arquivos.
- Build Rust e teste de integração real ficam pendentes em Windows com Claude Code instalado.

## Próximo passo

Etapa 10 — consolidar sessões e aprovações entre os três provedores, criar persistência/recuperação de sessão, normalizar eventos e usage, e completar o ciclo remoto Mobile para ações nativas de Codex e Claude.
