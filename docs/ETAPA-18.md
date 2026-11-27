# Etapa 18 — Execução remota de workflows

## Entregas

- `remote-server` recebe `WorkflowRunner` e `WorkflowRunStore` do Host.
- `POST /api/v1/workflows/{id}/run` inicia uma execução assíncrona e devolve `run_id` e snapshot inicial.
- `GET /api/v1/workflow-executions` retorna execuções ativas e resultados concluídos disponíveis no histórico.
- `POST /api/v1/workflow-executions/{id}/cancel` solicita cancelamento cooperativo do workflow.
- O WebSocket autenticado emite `workflow_event` com transições e eventos de cada agente.
- O Mobile permite selecionar um workflow, informar o caminho do projeto no Host e o objetivo, iniciar a execução e solicitar cancelamento.
- O Mobile reconcilia o estado por REST a cada 15 segundos e após reconectar; eventos WebSocket atualizam a interface entre reconciliações.

## Segurança

- Todas as rotas de execução, consulta e cancelamento exigem Bearer token de dispositivo pareado.
- O Host canonicaliza o caminho do repositório e exige que esteja dentro da raiz autorizada.
- O workflow é carregado do armazenamento local do Host; o Mobile não envia definições arbitrárias de agentes.
- As políticas de execução são validadas pelo `WorkflowRunner` antes de iniciar os nós.

## Limitações conhecidas

- Execuções ativas e seu buffer de eventos permanecem em memória; após reiniciar o Host, elas não são retomadas automaticamente.
- Eventos de workflow usam broadcast ao vivo, não o journal sequencial persistente de eventos de tarefas. Se o cliente perder eventos, deve reconciliar via `GET /api/v1/workflow-executions`.
- O histórico durável existente armazena resultados concluídos com sucesso. Falhas/cancelamentos ficam visíveis enquanto o Host permanece ativo, mas ainda não têm um registro durável próprio.
- O Mobile precisa informar um caminho absoluto válido no sistema de arquivos do Host. Não há seletor remoto de pastas nesta etapa.
- Build e testes Rust ainda precisam ser executados em ambiente com Rust toolchain; esta sessão não dispõe de `cargo`/`rustc`.
