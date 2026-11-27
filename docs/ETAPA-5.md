# Etapa 5 — Workflow Runner

## Execução

O runner consome um `WorkflowDefinition` validado e um diretório absoluto de repositório. O DAG é dividido em níveis topológicos; cada nível é executado em paralelo com `JoinSet`, e o nível seguinte só começa depois que o atual conclui.

## Contexto

Cada nó recebe o objetivo inicial. Saídas de predecessores só entram no prompt se a aresta tiver `pass_context=true`. O modo `none` não inclui saída; `summary` e `full_output` usam a saída textual disponível; `files_only` filtra linhas com referências aparentes a arquivos. O contexto total é limitado a 48 KiB e cada saída a 64 KiB.

> `summary` ainda não é um resumo semântico produzido por LLM; nesta versão usa a saída textual bruta limitada. A síntese dedicada será uma evolução separada.

## Isolamento

Nós `isolated` criam um Git Worktree por execução e nó. `shared` e `inherit` usam o repositório informado. Worktrees ficam registrados e preservados após a execução; remoção e merge continuam ações explícitas no Worktree Manager.

## Falhas

Falhas de execução são registradas como resultado do nó. Nós dependentes são marcados `skipped_dependency_failed`; ramos paralelos independentes não são cancelados. O status global é `failed` se algum nó falhar ou for bloqueado.

## Limitações

- Execução invocada pelo Desktop Tauri, ainda não disponível no endpoint remoto Mobile.
- A chamada atual aguarda o workflow terminar; não há `run_id` consultável nem cancelamento de workflow completo.
- Aprovações interativas ainda não são conectadas aos stdin/protocolos nativos dos CLIs.
- Importação e retomada de sessões preexistentes ainda não estão implementadas.
- Compilação Rust/Tauri e execução com CLIs reais precisam ser validadas no Windows 11.
