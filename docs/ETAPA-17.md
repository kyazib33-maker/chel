# Etapa 17 — Execução assíncrona e controle em tempo real

## Entregue

- Novo comando Tauri `start_workflow`: inicia em segundo plano e devolve imediatamente o `run_id`.
- Novo comando `list_workflow_executions`: consulta snapshots em memória das execuções ativas e recentes.
- Novo comando `cancel_workflow`: envia cancelamento cooperativo para o runner.
- Novo contrato `WorkflowProgressEvent`, com eventos de início, início/fim de nó, cancelamento e conclusão.
- `WorkflowRunner::run_controlled` recebe canal de cancelamento e canal de eventos. Ao cancelar, solicita cancelamento dos processos ativos antes de abortar as tarefas coordenadoras.
- O Desktop emite `workflow-progress` e `workflow-execution-finished`.
- O painel Execuções apresenta workflows ativos, eventos recentes por nó e botão de cancelamento.
- O Workflow Builder agora inicia a execução em segundo plano e devolve o controle à interface sem aguardar o workflow inteiro.
- Resultados concluídos com retorno normal continuam sendo persistidos pelo `WorkflowRunStore`.

## API Tauri

- `start_workflow(workflowId, repository, initialPrompt, policy)` → snapshot inicial com `run_id`.
- `list_workflow_executions()` → snapshots ativos/recentes (até 100).
- `cancel_workflow(runId)` → solicita cancelamento.
- Eventos: `workflow-progress` e `workflow-execution-finished`.

## Limitações conhecidas

- Snapshots de execução em andamento ficam em memória; após reiniciar o Desktop, execuções ativas não são reconstituídas. O histórico concluído continua persistente.
- O progresso é emitido por transição de nó, não por cada linha/token de saída do agente.
- A execução remota e a sincronização com o Mobile ainda não foram adicionadas nesta etapa.
- Pausar/retomar e checkpoints humanos entre nós continuam pendentes.
- O cancelamento é cooperativo: o runner solicita cancelamento dos processos conhecidos e interrompe as tarefas coordenadoras; processos externos podem levar algum tempo para encerrar.
- O comando legado `run_workflow` permanece disponível para compatibilidade, mas o Workflow Builder usa `start_workflow`.
- Build e testes Rust precisam ser executados em ambiente com Rust/Cargo instalado.
