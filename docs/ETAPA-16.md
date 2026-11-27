# Etapa 16 — Histórico e observabilidade de workflows

## Entregue

- Persistência local das execuções concluídas em `workflow-runs.json`.
- Retenção limitada às 100 execuções mais recentes para evitar crescimento ilimitado.
- Novo comando Tauri `list_workflow_runs`, com limite de consulta de 1 a 100.
- Nova página Desktop **Execuções**, com status geral, timestamps, resultado por agente, saída capturada e erros.
- Registro do resultado após a conclusão do Workflow Runner.
- Teste assíncrono de persistência e leitura do histórico.

## Limitações

- O runner ainda executa de forma síncrona na chamada Tauri; não existe identificador de execução consultável enquanto o fluxo está em andamento.
- Pausa, retomada, cancelamento de workflow e checkpoints humanos não fazem parte desta entrega.
- O histórico contém execuções concluídas com retorno normal do runner. Erros retornados antes da produção de `WorkflowRunResult` não são gravados como execução.
- O histórico está disponível no Desktop local; a API remota e o Mobile ainda não expõem essa coleção.
- A compilação Rust precisa ser executada em ambiente com Rust/Cargo instalado.
