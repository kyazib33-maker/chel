# Etapa 10 — Session Manager central

## Entregue

- Novo crate `session-manager` com registro persistente em JSON no diretório de dados do Tauri (`sessions.json`).
- Metadados unificados: provedor, ID local, ID nativo, diretório, modelo, estado, timestamps, estratégia de recuperação e último erro.
- Inicialização do registro marca sessões que estavam ativas como `interrupted`; não tenta ressuscitar processos que morreram com o Host.
- Integração de criação/encerramento com os adapters Claude Code e Codex App Server.
- Eventos dos adapters atualizam os estados persistidos (`running`, `idle`, `disconnected`).
- Endpoint remoto autenticado `GET /api/v1/sessions`.
- Nova Central de Sessões no Desktop e aba Sessões no Mobile.
- Teste unitário de recuperação de metadados após reinicialização.

## Limites deliberados

- Claude Code guarda o ID nativo e sinaliza suporte à retomada explícita via `--resume`, mas o fluxo de reanexação do processo ainda não está exposto na Central de Sessões.
- Codex guarda o thread ID, mas a retomada `thread/resume` ainda não está implementada no adapter; aparece como `metadata_only`.
- Antigravity ainda não possui adapter de sessão nativa. Não é listado como recuperável.
- A recuperação de metadados não significa que um processo antigo continua vivo. O estado é `interrupted` após reinicialização até uma retomada explícita.
- O Mobile consulta o registro e visualiza o estado; não envia mensagens ou encerra sessões nativas nesta etapa.

## Validação

- Revisão estrutural de manifests e integração realizada.
- Build/testes Rust e testes em CLIs reais não executados neste ambiente sem toolchain Rust/Cargo e CLIs instalados.
